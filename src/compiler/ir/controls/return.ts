import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueUseEmitter } from "#ir/node.js";
import {
  TerminalControlBase,
  type ControlEmitTarget
} from "./definition.js";

export type ReturnControlArgs = Readonly<{
  results: readonly ValueId[];
}>;

export class ReturnControl extends TerminalControlBase {
  static readonly kind = "return";
  readonly kind = ReturnControl.kind;
  readonly results: readonly ValueId[];
  readonly operands: readonly ValueId[];

  private constructor(sourceResults: readonly ValueId[]) {
    super();
    this.results = [...sourceResults];
    this.operands = this.results;
  }

  static create({ results }: ReturnControlArgs): ReturnControl {
    return new ReturnControl(results);
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    for (const result of this.results) {
      values.emitUse(result);
    }
    target.body.returnFromFunction();
  }
}

export const returnControl = ReturnControl;
