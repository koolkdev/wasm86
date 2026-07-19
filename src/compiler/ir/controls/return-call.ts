import { assert } from "#common/assert.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ValueId, ValueInput } from "#compiler/ir/values/types.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import type { ValueUseEmitter } from "#ir/node.js";
import {
  TerminalControlBase,
  type ControlEmitTarget
} from "./definition.js";

export type ReturnCallControlArgs = Readonly<{
  target: FunctionDefinition;
  arguments: readonly ValueInput[];
}>;

export class ReturnCallControl extends TerminalControlBase {
  static readonly kind = "returnCall";
  readonly kind = ReturnCallControl.kind;
  readonly operands: readonly ValueId[];
  override readonly directEffects: StorageEffects;

  private constructor(
    readonly target: FunctionDefinition,
    readonly inputs: readonly ValueInput[]
  ) {
    super();
    assert(
      inputs.length === target.type.parameters.length,
      `function ${target.ref.id} expects ${target.type.parameters.length} arguments, got ${inputs.length}`
    );
    for (const [index, input] of inputs.entries()) {
      const expected = target.type.parameters[index];

      assert(
        expected !== undefined,
        `function ${target.ref.id} has no parameter ${index}`
      );
      assert(
        input.type === expected,
        `function ${target.ref.id} argument ${index} must be ${expected}, got ${input.type}`
      );
    }
    this.operands = inputs.map((input) => input.value);
    this.directEffects = target.effects;
  }

  static create({
    target,
    arguments: inputs
  }: ReturnCallControlArgs): ReturnCallControl {
    return new ReturnCallControl(target, inputs);
  }

  emit(target: ControlEmitTarget, values: ValueUseEmitter): void {
    for (const input of this.inputs) {
      values.emitUse(input.value);
    }
    target.body.returnCallFunction(
      target.functionIndex(this.target)
    );
  }
}

export const returnCallControl = ReturnCallControl;
