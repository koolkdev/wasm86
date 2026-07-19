import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueUseEmitter } from "#ir/node.js";
import {
  TerminalControlBase,
  type ControlEmitTarget
} from "./definition.js";

export type Finish =
  | Readonly<{
      kind: "dispatch";
      targetEip: ValueId;
    }>
  | Readonly<{
      kind: "exit";
      result: ValueId;
    }>;

export type ExitFinish = Extract<Finish, { kind: "exit" }>;
export type DispatchFinish = Extract<Finish, { kind: "dispatch" }>;

export type FinishControlArgs = Readonly<{ finish: Finish }>;

export class FinishControl extends TerminalControlBase {
  static readonly kind = "finish";
  readonly kind = FinishControl.kind;
  readonly operands: readonly [ValueId];

  private constructor(readonly finish: Finish) {
    super();
    this.operands = finish.kind === "exit"
      ? [finish.result]
      : [finish.targetEip];
  }

  static create({ finish }: FinishControlArgs): FinishControl {
    return new FinishControl(finish);
  }

  emit(target: ControlEmitTarget, _values: ValueUseEmitter): void {
    switch (this.finish.kind) {
      case "exit":
        target.emitExit(this.finish.result);
        return;
      case "dispatch":
        target.emitDispatch(this.finish.targetEip);
        return;
    }
  }
}

export const finishControl = FinishControl;
