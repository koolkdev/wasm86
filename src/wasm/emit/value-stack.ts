import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { OpAction } from "#ir/actions.js";
import { opAccess, type IrOp } from "#ir/ops.js";
import type { Body } from "#ir/block.js";
import { bodyContains, bodyInputValues } from "#ir/traverse.js";
import {
  valueChildren,
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
import type { BlockPlacement, ScheduledEmission } from "./placement.js";

// Turns placement + the value graph into stack code. emitUse pushes exactly
// one use of a value; anything needed more than once is captured into a
// refcounted scratch local and replayed until its last counted use. An
// emission that observes one operand several times borrows it instead of
// consuming extra uses. The local registry is the only scratch-local
// mechanism in the emitter; borrows pin its locals rather than copy them.

export type ValueStackContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  placement: BlockPlacement;
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

// A deferred producer op awaiting its scheduled emissions, consumed in
// emission order.
type PendingProducer = { action: OpAction; emissions: ScheduledEmission[] };

type BorrowPolicy = Readonly<{ first(): void; repeat(): void; close?(): void }>;

export class ValueStack implements OperandUses {
  readonly #context: ValueStackContext;
  readonly #body: WasmFunctionBodyEncoder;
  readonly #values: ValueTable;
  readonly #placement: BlockPlacement;
  readonly #registry: LocalRegistry;
  // Deferred producer ops, recorded at their action point: each scope
  // that itself demands the value emits the op once — at its first use
  // there or at a subtree's entry — and every use replays that local.
  readonly #pending = new Map<ValueId, PendingProducer>();
  // Open borrows per value; assertClear reports leaks.
  readonly #borrows = new Map<ValueId, number>();
  // Loop input leaf -> its carried cell's local, bound for the loop extent.
  readonly #loopInputLocals = new Map<ValueId, number>();

  constructor(context: ValueStackContext) {
    this.#context = context;
    this.#body = context.body;
    this.#values = context.values;
    this.#placement = context.placement;
    this.#registry = new LocalRegistry(context.body, context.scratch);
  }

  // The driver calls this at each output-producing op action point, in
  // action order.
  scheduledProducer(action: OpAction): void {
    const output = action.output;

    assert(output !== undefined, `${action.op.kind} op action is missing its output`);

    const uses = this.#placement.useCount(output);
    const placement = this.#placement.outputPlacement(output);

    switch (placement.kind) {
      case "deferToUse":
        // Each demanding scope emits the op once; a dead pure op never
        // executes.
        if (uses > 0) {
          this.#pending.set(output, { action, emissions: [...placement.emissions] });
        }

        return;
      case "captureAtProducer":
        this.#context.emitOp(action.op, this);
        this.#registry.captureSet(output, uses, this.#typeOf(output));
        return;
    }
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
      // A deferred producer executes here, at its scope's first use, and
      // tees for the rest of that scope's uses.
      case "actionOutput": {
        const uses = this.#emitPendingProducer(id);

        if (uses > 1) {
          this.#registry.captureTee(id, uses - 1, this.#typeOf(id));
        }

        return;
      }
      default: {
        this.#emitCompute(node);

        const uses = this.#placement.useCount(id);

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

  // Called before entering a nested body: its actions are emitted later
  // but executes here, so anything it consumes from the parent context must
  // be replayable from a local. A loop body passes its input leaves as
  // `bodyProduced` — values computed from them materialize inside, per
  // iteration, never here.
  captureForBody(body: Body, bodyProduced: readonly ValueId[] = []): void {
    for (const id of bodyInputValues(body, this.#values, bodyProduced)) {
      this.#captureValue(id, body);
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

  // A control action's output local: arms store into it, the scope's uses
  // replay it. A dead output claims nothing.
  claimActionOutput(output: ValueId): number | undefined {
    const uses = this.#placement.useCount(output);

    if (uses === 0) {
      return undefined;
    }

    return this.#registry.claim(output, uses, this.#typeOf(output));
  }

  // Every captured value fully consumed, every scratch local returned.
  assertClear(): void {
    assert(
      this.#borrows.size === 0,
      `borrowed values never released: ${[...this.#borrows.keys()].join(", ")}`
    );
    assert(
      this.#pending.size === 0,
      `deferred producers never emitted: ${[...this.#pending.keys()].join(", ")}`
    );
    assert(
      this.#loopInputLocals.size === 0,
      `loop inputs never unbound: ${[...this.#loopInputLocals.keys()].join(", ")}`
    );
    this.#registry.assertClear();
  }

  // Executes one use-anchored emission of a deferred producer and returns
  // the counted uses it covers.
  #emitPendingProducer(id: ValueId): number {
    const deferred = this.#pending.get(id);

    assert(deferred !== undefined, `action output ${id} has no deferred producer to emit`);

    const emission = deferred.emissions.shift();

    assert(emission !== undefined, `deferred producer ${id} has no scheduled emissions left`);
    assert(
      emission.anchor === "use",
      `deferred producer ${id} reached a use before its scheduled body entry`
    );
    if (deferred.emissions.length === 0) {
      this.#pending.delete(id);
    }

    this.#context.emitOp(deferred.action.op, this);
    return emission.uses;
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

  #captureValue(id: ValueId, forBody: Body): void {
    if (this.#registry.has(id)) {
      return;
    }

    // A dead value — a dead control output's result — is never consumed.
    if (this.#placement.useCount(id) === 0) {
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
        const deferred = this.#pending.get(id);

        assert(deferred !== undefined, `action output ${id} has no replay source`);

        const index = deferred.emissions.findIndex((entry) => bodyContains(forBody, entry.body));

        // No emission under this body: an earlier one on the enclosing
        // flow serves its uses before the body runs.
        if (index === -1) {
          return;
        }

        const emission = deferred.emissions[index]!;

        if (emission.anchor === "bodyEntry" && emission.body === forBody) {
          // The scope's emission is anchored here: execute the op on the
          // enclosing flow, before the owning control action, and let
          // every use replay the local.
          deferred.emissions.splice(index, 1);
          if (deferred.emissions.length === 0) {
            this.#pending.delete(id);
          }

          this.#context.emitOp(deferred.action.op, this);
          this.#registry.captureSet(id, emission.uses, this.#typeOf(id));
          return;
        }

        // The emission lands inside the body: capture what re-emitting
        // the op there needs — its transitive input closure — never the
        // output itself.
        for (const input of opAccess(deferred.action.op).valueInputs) {
          this.#captureValue(input, forBody);
        }

        return;
      }
      default: {
        // Not in the registry means nothing consumed it yet (the pending
        // nested-body use keeps a consumed multi-use compound captured, so
        // every counted use is still to come.
        this.#captureNestedBodyEntryProducers(id, forBody);
        this.#emitCompute(node);
        this.#registry.captureSet(id, this.#placement.useCount(id), this.#typeOf(id));
        return;
      }
    }
  }

  // A compound input can wrap a deferred producer whose emission is
  // anchored at this body's entry — placement refuses to sink pure ops into
  // loop bodies, but the compound itself stays a body input because it does
  // not depend on the loop's own leaves. Capture such producers first so
  // computing the compound replays their locals.
  #captureNestedBodyEntryProducers(id: ValueId, forBody: Body): void {
    const node = this.#values.node(id);

    if (node.kind === "actionOutput") {
      const deferred = this.#pending.get(id);

      if (
        deferred !== undefined &&
        deferred.emissions.some((emission) => emission.anchor === "bodyEntry" && emission.body === forBody)
      ) {
        this.#captureValue(id, forBody);
      }

      return;
    }

    for (const child of valueChildren(node)) {
      this.#captureNestedBodyEntryProducers(child, forBody);
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
