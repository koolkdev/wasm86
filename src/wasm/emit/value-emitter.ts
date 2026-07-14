import { assert } from "#common/assert.js";
import type { ExternalValueId } from "#ir/operands.js";
import type { OpAction } from "#ir/actions.js";
import type { IrOp } from "#ir/ops.js";
import type { ValueEmitContext } from "#compiler/ir/values/definition.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmLocalScratchAllocator } from "#compiler/encoder/local-scratch.js";
import { LocalRegistry } from "./local-registry.js";
import type { BorrowedUse, OperandUses } from "./ops.js";
import { wasmValueType, type WasmValueType } from "#compiler/encoder/types.js";
import type { ValueUses } from "./value-uses.js";

// Turns captured values plus the value graph into stack code. emitUse pushes
// one use; repeated values replay a temporary local until their final use.
// An op that observes one operand several times borrows it without consuming
// extra uses.

export type ValueEmitterContext = Readonly<{
  body: WasmFunctionBodyEncoder;
  scratch: WasmLocalScratchAllocator;
  values: ValueTable;
  uses: ValueUses;
  // External id -> the wasm local the embedding bound it to.
  externalLocals: ReadonlyMap<ExternalValueId, number>;
  // Emits one op, consuming its value inputs through the given uses; the
  // driver wires this to the op lowering layer, so the emitter never sees
  // slot offsets or the helper registry.
  emitOp(op: IrOp, operands: OperandUses): void;
  // Claims the verified use event for an uncaptured action output.
  // Scheduling remains outside this emitter.
  claimProducerAtUse(output: ValueId): OpAction;
}>;

export class ValueEmitter implements OperandUses {
  readonly #context: ValueEmitterContext;
  readonly #body: WasmFunctionBodyEncoder;
  readonly #values: ValueTable;
  readonly #uses: ValueUses;
  readonly #registry: LocalRegistry;
  readonly #valueEmitContext: ValueEmitContext;
  // Open borrows per value; assertClear reports leaks.
  readonly #borrows = new Map<ValueId, number>();
  // Loop input leaf -> its carried cell's local, bound for the loop extent.
  readonly #loopInputLocals = new Map<ValueId, number>();
  // Semantic var index -> its backing local, held for the fragment.
  readonly #varLocals = new Map<number, number>();

  constructor(context: ValueEmitterContext) {
    this.#context = context;
    this.#body = context.body;
    this.#values = context.values;
    this.#uses = context.uses;
    this.#registry = new LocalRegistry(context.body, context.scratch);
    this.#valueEmitContext = {
      body: this.#body,
      emitUse: (id) => this.emitUse(id),
      emitActionOutput: (id) => {
        this.#emitProducerAtUse(this.#context.claimProducerAtUse(id));
      },
      emitExternal: (external) => {
        const local = this.#context.externalLocals.get(external);

        assert(local !== undefined, `no local bound for external value ${external}`);
        this.#body.localGet(local);
      },
      emitLoopInput: (id) => {
        const local = this.#loopInputLocals.get(id);

        assert(local !== undefined, `no local bound for loop input value ${id}`);
        this.#body.localGet(local);
      }
    };
  }

  // Executes a capture event. Every counted use later replays its temporary
  // local, which recycles after the final reference.
  captureProducer(action: OpAction): void {
    const output = action.output;

    assert(output !== undefined, `${action.op.kind} op action is missing its output`);
    const uses = this.#uses.useCount(output);

    assert(uses > 0, `scheduled action output ${output} has no emitted uses`);
    this.#context.emitOp(action.op, this);
    this.#registry.captureSet(output, uses, this.#typeOf(output));
  }

  // Executes a use event. The first use stays on the stack; a tee captures
  // only when later counted uses remain.
  #emitProducerAtUse(action: OpAction): void {
    const output = action.output;

    assert(output !== undefined, `${action.op.kind} op action is missing its output`);
    const uses = this.#uses.useCount(output);

    assert(uses > 0, `scheduled action output ${output} has no emitted uses`);
    this.#context.emitOp(action.op, this);
    if (uses > 1) {
      this.#registry.captureTee(output, uses - 1, this.#typeOf(output));
    }
  }

  // Pushes one use of the value onto the stack.
  emitUse(id: ValueId): void {
    if (this.#registry.replay(id)) {
      return;
    }

    const capture = this.#values.captureMode(id);

    this.#values.emit(id, this.#valueEmitContext);

    if (capture === "compute" || capture === "unreachable") {
      const uses = this.#uses.useCount(id);

      if (uses > 1) {
        this.#registry.captureTee(id, uses - 1, this.#typeOf(id));
      }
    }
  }

  // Borrows one counted use of the value for repeated observation. The local
  // is unpinned in finally, and an escaped borrowed handle cannot be pushed.
  withBorrowedUse(id: ValueId, callback: (borrowed: BorrowedUse) => void): void {
    const reemittable = this.#values.captureMode(id) === "reemit";
    let active = true;
    let pushed = false;
    let pinned = false;
    const borrowed: BorrowedUse = {
      push: (): void => {
        assert(active, `borrowed value ${id} pushed outside its scope`);

        if (!pushed) {
          if (reemittable) {
            this.emitUse(id);
          } else {
            // Record ownership before replay: if replay fails, the callback
            // scope's finally still unpins while the fragment aborts.
            if (this.#registry.has(id)) {
              this.#registry.pin(id);
              pinned = true;
              this.emitUse(id);
            } else {
              this.emitUse(id);

              if (this.#registry.has(id)) {
                this.#registry.pin(id);
              } else {
                this.#registry.capturePinned(id, this.#typeOf(id));
              }
              pinned = true;
            }
          }
          pushed = true;
          return;
        }

        if (reemittable) {
          this.emitUse(id);
        } else {
          this.#registry.peek(id);
        }
      }
    };

    this.#borrows.set(id, (this.#borrows.get(id) ?? 0) + 1);
    try {
      callback(borrowed);
      assert(pushed, `borrowed value ${id} was never pushed`);
    } finally {
      active = false;

      try {
        if (pinned) {
          this.#registry.unpin(id);
        }
      } finally {
        const remaining = this.#borrows.get(id);

        assert(remaining !== undefined && remaining > 0, `borrowed value ${id} is not active`);
        remaining === 1 ? this.#borrows.delete(id) : this.#borrows.set(id, remaining - 1);
      }
    }
  }

  constValue(id: ValueId): number | undefined {
    return this.#values.constValue(id);
  }

  // Captures parent-context values that later-emitted code needs to replay.
  // The action driver owns body traversal and supplies only those inputs.
  captureValues(ids: Iterable<ValueId>): void {
    for (const id of ids) {
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
  // replay it until the final emitted reference.
  claimControlOutput(output: ValueId): number {
    const uses = this.#uses.useCount(output);

    assert(uses > 0, `live control output ${output} has no emitted uses`);
    return this.#registry.claimOutputLocal(output, uses, this.#typeOf(output));
  }

  releaseFragmentLocals(): void {
    this.releaseVarLocals();
    this.#registry.releaseOutputBindings();
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
    assert(
      this.#varLocals.size === 0,
      `semantic var locals never released: ${[...this.#varLocals.keys()].join(", ")}`
    );
    this.#registry.assertClear();
  }

  #captureValue(id: ValueId): void {
    if (this.#registry.has(id)) {
      return;
    }

    // A dead value — a dead control output's result — is never consumed.
    if (this.#uses.useCount(id) === 0) {
      return;
    }

    const capture = this.#values.captureMode(id);

    if (capture === "reemit" || capture === "unreachable") {
      return;
    }

    assert(capture === "compute", `action output ${id} has no replay source`);
    assert(
      canEvaluateWithoutTrap(
        this.#values,
        id,
        (value) => this.#registry.has(value)
      ),
      `value ${id} may trap and cannot be captured before a nested body is selected`
    );
    // Not in the registry means nothing consumed it yet, so every counted
    // use is still to come.
    this.#values.emit(id, this.#valueEmitContext);
    this.#registry.captureSet(id, this.#uses.useCount(id), this.#typeOf(id));
  }

  #typeOf(id: ValueId): WasmValueType {
    return wasmTypeForValue(this.#values.valueType(id));
  }
}

export function wasmTypeForValue(type: ValueType): WasmValueType {
  return type === "i32" ? wasmValueType.i32 : wasmValueType.i64;
}

// A value already evaluated on the current path is replayed from its local,
// so it cuts off a possibly trapping dependency closure. This query keeps
// that path state outside the table's static non-trapping fact.
export function canEvaluateWithoutTrap(
  values: ValueTable,
  id: ValueId,
  isAlreadyBound: (value: ValueId) => boolean
): boolean {
  const contextual = new Map<ValueId, boolean>();
  const visit = (value: ValueId): boolean => {
    const existing = contextual.get(value);

    if (existing !== undefined) {
      return existing;
    }

    if (values.isNonTrapping(value) || isAlreadyBound(value)) {
      contextual.set(value, true);
      return true;
    }

    const result = !values.mayTrap(value) && values.children(value).every(visit);

    contextual.set(value, result);
    return result;
  };

  return visit(id);
}
