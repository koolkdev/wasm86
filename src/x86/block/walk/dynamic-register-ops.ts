import type { ExprRef } from "#x86/expr/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { BlockWalkRecorder } from "./recorder.js";
import type { RegisterWalkState } from "./registers.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class DynamicRegisterWalkOps {
  readonly #recorder: BlockWalkRecorder;
  readonly #registers: RegisterWalkState;
  readonly #site: () => OpSite;
  readonly #snapshot: () => BlockState;
  #syncedRevision: number;

  constructor(input: Readonly<{
    recorder: BlockWalkRecorder;
    registers: RegisterWalkState;
    site: () => OpSite;
    snapshot: () => BlockState;
  }>) {
    this.#recorder = input.recorder;
    this.#registers = input.registers;
    this.#site = input.site;
    this.#snapshot = input.snapshot;
    this.#syncedRevision = input.registers.revision;
  }

  load(index: ExprRef, width: OperandWidth): ExprRef {
    const result = this.#recorder.dynamicRegisterLoad(this.#site(), index, width);

    this.#registers.dynamicLoad(index, width);
    return result;
  }

  store(index: ExprRef, value: ExprRef, width: OperandWidth): void {
    const at = this.#site();

    if (this.#registers.revision !== this.#syncedRevision) {
      this.#recorder.stateSync(at, this.#snapshot());
      this.#syncedRevision = this.#registers.revision;
    }

    this.#recorder.action(Object.freeze({
      kind: "dynamicRegisterStore",
      at,
      index,
      value,
      width
    }));
    this.#registers.dynamicStore(index, value, width);
  }
}
