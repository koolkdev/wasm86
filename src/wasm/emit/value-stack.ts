import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { OpAction } from "#ir/actions.js";
import type { IrOp } from "#ir/ops.js";
import type { Body } from "#ir/block.js";
import { bodyInputValues } from "#ir/traverse.js";
import {
  type BinaryValueNode,
  type CompareValueNode,
  type ExtendValueNode,
  type SelectValueNode,
  type TruncateValueNode,
  type UnaryValueNode,
  type UnreachableValueNode,
  type ValueId
} from "#ir/values.js";
import type { ValueTable } from "#ir/value-table.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#wasm/encoder/local-scratch.js";
import { LocalRegistry } from "./local-registry.js";
import type { BorrowedUse, OperandUses } from "./ops.js";
import {
  emitBinaryOperator,
  emitCompareOperator,
  emitExtend,
  emitTruncate,
  emitUnaryOperator,
  wasmTypeForValue
} from "./operators.js";
import type { ValueUses } from "./value-uses.js";
import { ValueTraits } from "./value-traits.js";

// Turns stable output locals plus the value graph into stack code. emitUse
// pushes exactly one use of a value; compounds needed more than once are
// temporarily captured and replayed until their last counted use. An
// emission that observes one operand several times borrows it instead of
// consuming extra uses.

export type ValueStackContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  uses: ValueUses;
  // External id -> the wasm local the embedding bound it to.
  externalLocals: ReadonlyMap<ExternalValueId, number>;
  // Emits one op, consuming its value inputs through the given uses; the
  // driver wires this to the op lowering layer, so the stack never sees
  // slot offsets or the helper registry.
  emitOp(op: IrOp, operands: OperandUses): void;
}>;

type CompoundValueNode =
  | BinaryValueNode
  | UnreachableValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | TruncateValueNode
  | ExtendValueNode;

type BorrowPolicy = Readonly<{ first(): void; repeat(): void; close?(): void }>;

export class ValueStack implements OperandUses {
  readonly #context: ValueStackContext;
  readonly #body: WasmFunctionBodyEncoder;
  readonly #values: ValueTable;
  readonly #uses: ValueUses;
  readonly #traits: ValueTraits;
  readonly #registry: LocalRegistry;
  // Open borrows per value; assertClear reports leaks.
  readonly #borrows = new Map<ValueId, number>();
  // Loop input leaf -> its carried cell's local, bound for the loop extent.
  readonly #loopInputLocals = new Map<ValueId, number>();
  // Semantic var index -> its backing local, held for the fragment.
  readonly #varLocals = new Map<number, number>();

  constructor(context: ValueStackContext) {
    this.#context = context;
    this.#body = context.body;
    this.#values = context.values;
    this.#uses = context.uses;
    this.#traits = new ValueTraits(context.values);
    this.#registry = new LocalRegistry(context.body, context.scratch);
  }

  // A live output-producing op executes at its action point and stores into
  // one fragment-owned output local. Every later use reads that local.
  materializeActionOutput(action: OpAction): void {
    const output = action.output;

    assert(output !== undefined, `${action.op.kind} op action is missing its output`);
    this.#context.emitOp(action.op, this);
    this.#registry.captureOutputSet(output, this.#typeOf(output));
  }

  // Pushes one use of the value onto the stack.
  emitUse(id: ValueId): void {
    if (this.#registry.replay(id)) {
      return;
    }

    const node = this.#values.node(id);

    switch (node.kind) {
      case "const":
        this.#body.i32Const(node.value);
        return;
      case "const64":
        this.#body.i64Const(node.value);
        return;
      case "external": {
        const local = this.#context.externalLocals.get(node.external);

        assert(local !== undefined, `no local bound for external value ${node.external}`);
        this.#body.localGet(local);
        return;
      }
      case "loopInput": {
        const local = this.#loopInputLocals.get(id);

        assert(local !== undefined, `no local bound for loop input value ${id}`);
        this.#body.localGet(local);
        return;
      }
      case "actionOutput": {
        assert(false, `action output ${id} has no local binding`);
        return;
      }
      default: {
        this.#emitCompute(node);

        const uses = this.#uses.useCount(id);

        if (uses > 1) {
          this.#registry.captureTee(id, uses - 1, this.#typeOf(id));
        }

        return;
      }
    }
  }

  // Borrows one counted use of the value for repeated observation.
  borrowUse(id: ValueId): BorrowedUse {
    const node = this.#values.node(id);

    // Consts, externals, and loop inputs re-emit freely; the borrow holds
    // nothing.
    if (
      node.kind === "const" ||
      node.kind === "const64" ||
      node.kind === "external" ||
      node.kind === "loopInput"
    ) {
      const reemit = () => this.emitUse(id);

      return this.#createBorrow(id, { first: reemit, repeat: reemit });
    }

    // Everything else consumes its counted use at the first push and pins
    // the registry local it lands in until release.
    return this.#createBorrow(id, {
      first: () => this.#emitPinnedUse(id),
      repeat: () => this.#registry.peek(id),
      close: () => this.#registry.unpin(id)
    });
  }

  constValue(id: ValueId): number | undefined {
    return this.#values.constValue(id);
  }

  // Called before entering a nested body: its actions are emitted later
  // but executes here, so anything it consumes from the parent context must
  // be replayable from a local. A loop body passes its input leaves as
  // `bodyProduced` — values computed from them materialize inside, per
  // iteration, never here.
  captureForBody(body: Body, bodyProduced: readonly ValueId[] = []): void {
    for (const id of bodyInputValues(body, this.#values, bodyProduced)) {
      this.#captureValue(id);
    }
  }

  // Binds a loop input to its carried cell's local for the loop extent;
  // every use inside replays the local without counting.
  bindLoopInput(id: ValueId, local: number): void {
    assert(this.#values.node(id).kind === "loopInput", `value ${id} is not a loop input`);
    assert(!this.#loopInputLocals.has(id), `loop input ${id} is already bound`);
    this.#loopInputLocals.set(id, local);
  }

  unbindLoopInput(id: ValueId): void {
    assert(this.#loopInputLocals.delete(id), `loop input ${id} is not bound`);
  }

  // A semantic var's backing local: allocated on first touch, stable until
  // releaseVarLocals at fragment end. Instruction-scoped var indices reuse
  // the same local across instructions; each seed write re-initializes it.
  varLocal(variable: number): number {
    const existing = this.#varLocals.get(variable);

    if (existing !== undefined) {
      return existing;
    }

    const local = this.#context.scratch.allocLocal(wasmTypeForValue("i32"));

    this.#varLocals.set(variable, local);
    return local;
  }

  releaseVarLocals(): void {
    for (const local of this.#varLocals.values()) {
      this.#context.scratch.freeLocal(local);
    }

    this.#varLocals.clear();
  }

  // A live control action's output local: arms store into it and later uses
  // replay it for the rest of the fragment.
  claimActionOutput(output: ValueId): number {
    return this.#registry.claimOutputLocal(output, this.#typeOf(output));
  }

  releaseFragmentLocals(): void {
    this.releaseVarLocals();
    this.#registry.releaseOutputLocals();
  }

  // Every captured value fully consumed, every scratch local returned.
  assertClear(): void {
    assert(
      this.#borrows.size === 0,
      `borrowed values never released: ${[...this.#borrows.keys()].join(", ")}`
    );
    assert(
      this.#loopInputLocals.size === 0,
      `loop inputs never unbound: ${[...this.#loopInputLocals.keys()].join(", ")}`
    );
    this.#registry.assertClear();
  }

  #emitCompute(node: CompoundValueNode): void {
    switch (node.kind) {
      case "unreachable":
        this.#body.unreachable();
        return;
      case "binary":
        this.emitUse(node.a);
        this.emitUse(node.b);
        emitBinaryOperator(this.#body, node);
        return;
      case "unary":
        this.emitUse(node.value);
        emitUnaryOperator(this.#body, node);
        return;
      case "compare": {
        // eq against zero is wasm's eqz; the other zero compares have no
        // dedicated opcode.
        const eqzOperand = node.type === "i32" ? this.#zeroEqualityOperand(node) : undefined;

        if (eqzOperand !== undefined) {
          this.emitUse(eqzOperand);
          this.#body.i32Eqz();
          return;
        }

        this.emitUse(node.a);
        this.emitUse(node.b);
        emitCompareOperator(this.#body, node);
        return;
      }
      case "select":
        this.emitUse(node.whenTrue);
        this.emitUse(node.whenFalse);
        this.emitUse(node.condition);
        this.#body.select();
        return;
      case "truncate":
        this.emitUse(node.value);
        emitTruncate(this.#body, node);
        return;
      case "extend":
        this.emitUse(node.value);
        emitExtend(this.#body, node);
        return;
    }
  }

  #zeroEqualityOperand(node: CompareValueNode): ValueId | undefined {
    if (node.operator !== "eq") {
      return undefined;
    }

    if (this.#isConstZero(node.a)) {
      return node.b;
    }

    return this.#isConstZero(node.b) ? node.a : undefined;
  }

  #isConstZero(id: ValueId): boolean {
    const node = this.#values.node(id);

    return node.kind === "const" && node.value === 0;
  }

  #captureValue(id: ValueId): void {
    if (this.#registry.has(id)) {
      return;
    }

    // A dead value — a dead control output's result — is never consumed.
    if (this.#uses.useCount(id) === 0) {
      return;
    }

    const node = this.#values.node(id);

    switch (node.kind) {
      case "const":
      case "const64":
      case "external":
      case "loopInput":
      case "unreachable":
        // Re-emittable anywhere.
        return;
      case "actionOutput": {
        assert(false, `action output ${id} has no replay source`);
        return;
      }
      default: {
        assert(
          this.#traits.canEvaluateWithoutTrap(id, (value) => this.#registry.has(value)),
          `value ${id} may trap and cannot be captured before a nested body is selected`
        );
        // Not in the registry means nothing consumed it yet, so every
        // counted use is still to come.
        this.#emitCompute(node);
        this.#registry.captureSet(id, this.#uses.useCount(id), this.#typeOf(id));
        return;
      }
    }
  }

  // Tracks the borrow and enforces the push/release order; the policy says
  // what to emit.
  #createBorrow(id: ValueId, policy: BorrowPolicy): BorrowedUse {
    let pushed = false;
    let released = false;

    this.#borrows.set(id, (this.#borrows.get(id) ?? 0) + 1);

    return {
      push: (): void => {
        assert(!released, `borrowed value ${id} pushed after release`);
        pushed ? policy.repeat() : policy.first();
        pushed = true;
      },
      release: (): void => {
        assert(!released, `borrowed value ${id} released twice`);
        assert(pushed, `borrowed value ${id} released without a push`);
        released = true;

        const remaining = this.#borrows.get(id)! - 1;

        remaining === 0 ? this.#borrows.delete(id) : this.#borrows.set(id, remaining);
        policy.close?.();
      }
    };
  }

  // Emits one counted use of the value and pins its registry local.
  #emitPinnedUse(id: ValueId): void {
    // Pin first: the replay below may consume the last counted use.
    if (this.#registry.has(id)) {
      this.#registry.pin(id);
      this.emitUse(id);
      return;
    }

    // A multi-use value tees itself into the registry when computed; a
    // single-use one is captured under the pin alone.
    this.emitUse(id);

    if (this.#registry.has(id)) {
      this.#registry.pin(id);
    } else {
      this.#registry.capturePinned(id, this.#typeOf(id));
    }
  }

  #typeOf(id: ValueId) {
    return wasmTypeForValue(this.#values.valueType(id));
  }
}
