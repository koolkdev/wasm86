import type { ExprRef } from "#ir/expr/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { BlockWalkRecorder } from "./recorder.js";
import type { RegisterAccessValidator } from "./register-access-validator.js";
import type { RegisterWalkState } from "./registers.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class DynamicRegisterWalkOps {
  readonly #recorder: BlockWalkRecorder;
  readonly #registers: RegisterWalkState;
  readonly #validator: RegisterAccessValidator;
  readonly #site: () => OpSite;
  readonly #snapshot: () => BlockState;
  #syncedRevision: number;

  constructor(input: Readonly<{
    recorder: BlockWalkRecorder;
    registers: RegisterWalkState;
    validator: RegisterAccessValidator;
    site: () => OpSite;
    snapshot: () => BlockState;
  }>) {
    this.#recorder = input.recorder;
    this.#registers = input.registers;
    this.#validator = input.validator;
    this.#site = input.site;
    this.#snapshot = input.snapshot;
    this.#syncedRevision = input.registers.revision;
  }

  load(index: ExprRef, width: OperandWidth): ExprRef {
    const at = this.#site();
    this.#validator.dynamicLoad(at);

    return this.#recorder.dynamicRegisterLoad(at, index, width);
  }

  store(index: ExprRef, value: ExprRef, width: OperandWidth): void {
    const at = this.#site();

    if (this.#registers.revision !== this.#syncedRevision) {
      this.#recorder.stateSync(at, this.#snapshot());
      this.#syncedRevision = this.#registers.revision;
    }

    this.#validator.dynamicStore(at);
    this.#recorder.action(Object.freeze({
      kind: "dynamicRegisterStore",
      at,
      index,
      value,
      width
    }));
    this.#registers.resetForDynamicRegisterStore();
  }
}
