import type { ExprRef } from "#x86/expr/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { BlockWalkRecorder } from "./recorder.js";
import type { RegisterWalkState } from "./registers.js";
import type { OpSite } from "./site.js";

export class DynamicRegisterWalkOps {
  readonly #recorder: BlockWalkRecorder;
  readonly #registers: RegisterWalkState;
  readonly #site: () => OpSite;

  constructor(input: Readonly<{
    recorder: BlockWalkRecorder;
    registers: RegisterWalkState;
    site: () => OpSite;
  }>) {
    this.#recorder = input.recorder;
    this.#registers = input.registers;
    this.#site = input.site;
  }

  load(index: ExprRef, width: OperandWidth): ExprRef {
    const result = this.#recorder.dynamicRegisterLoad(this.#site(), index, width);

    this.#registers.dynamicLoad(index, width);
    return result;
  }

  store(index: ExprRef, value: ExprRef, width: OperandWidth): void {
    this.#recorder.action(Object.freeze({
      kind: "dynamicRegisterStore",
      at: this.#site(),
      index,
      value,
      width
    }));
    this.#registers.dynamicStore(index, value, width);
  }
}
