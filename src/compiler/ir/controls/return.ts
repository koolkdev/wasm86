import {
  noStorageEffects,
  type StorageEffects
} from "#compiler/ir/effects.js";
import { Invocation } from "#compiler/ir/invocation.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueUseEmitter } from "#compiler/ir/node.js";
import {
  TerminalControlBase,
  type ControlEmitTarget
} from "./definition.js";

export type ReturnSource =
  | Readonly<{ kind: "values"; values: readonly ValueId[] }>
  | Readonly<{ kind: "invocation"; invocation: Invocation }>;

export type ReturnControlArgs = Readonly<{ source: ReturnSource }>;

export class ReturnControl extends TerminalControlBase {
  static readonly kind = "return";
  readonly kind = ReturnControl.kind;
  readonly source: ReturnSource;
  readonly operands: readonly ValueId[];
  override readonly directEffects: StorageEffects;

  private constructor(source: ReturnSource) {
    super();
    switch (source.kind) {
      case "values":
        this.source = { kind: "values", values: [...source.values] };
        this.operands = this.source.values;
        this.directEffects = noStorageEffects;
        break;
      case "invocation":
        this.source = source;
        this.operands = source.invocation.inputs.map((input) => input.value);
        this.directEffects = source.invocation.target.effects;
        break;
    }
  }

  static create({ source }: ReturnControlArgs): ReturnControl {
    return new ReturnControl(source);
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    switch (this.source.kind) {
      case "values":
        for (const value of this.source.values) {
          values.emitUse(value);
        }
        target.body.returnFromFunction();
        return;
      case "invocation":
        this.source.invocation.emitInputs(values);
        target.emitReturnCall(this.source.invocation.target);
        return;
    }
  }
}

export const returnControl = ReturnControl;
