import {
  noStorageEffects,
  type StorageEffects
} from "#compiler/ir/effects.js";
import { Invocation } from "#compiler/ir/invocation.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { TerminalControlBase } from "./definition.js";

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
}

export const returnControl = ReturnControl;
