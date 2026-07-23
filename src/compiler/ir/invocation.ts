import { assert } from "#common/assert.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import type { ValueInput } from "#compiler/ir/values/types.js";
import type { FunctionType } from "#compiler/ir/function.js";
import type { FunctionRef, TableRef } from "#compiler/ir/refs.js";

export type DirectCallTarget = Readonly<{
  kind: "direct";
  ref: FunctionRef;
  type: FunctionType;
  effects: StorageEffects;
}>;

export type CallTarget = DirectCallTarget | IndirectCallTarget;

export type IndirectCallTargetArgs = Readonly<{
  table: TableRef;
  type: FunctionType;
  effects: StorageEffects;
  elementIndex: ValueInput;
}>;

export class IndirectCallTarget {
  readonly kind = "indirect";

  private constructor(
    readonly table: TableRef,
    readonly type: FunctionType,
    readonly effects: StorageEffects,
    readonly elementIndex: ValueInput
  ) {
    assert(
      elementIndex.type === "i32",
      `indirect call table element index must be i32, got ${elementIndex.type}`
    );
  }

  static create({
    table,
    type,
    effects,
    elementIndex
  }: IndirectCallTargetArgs): IndirectCallTarget {
    return new IndirectCallTarget(table, type, effects, elementIndex);
  }
}

export type InvocationArgs = Readonly<{
  target: CallTarget;
  arguments: readonly ValueInput[];
}>;

// A call's target and typed inputs, independent of how its results are consumed.
export class Invocation {
  readonly arguments: readonly ValueInput[];
  readonly inputs: readonly ValueInput[];

  private constructor(
    readonly target: CallTarget,
    sourceArguments: readonly ValueInput[]
  ) {
    this.arguments = [...sourceArguments];
    assert(
      this.arguments.length === target.type.parameters.length,
      `call target expects ${target.type.parameters.length} arguments, got ${this.arguments.length}`
    );
    for (const [index, input] of this.arguments.entries()) {
      const expected = target.type.parameters[index];

      assert(expected !== undefined, `call target has no parameter ${index}`);
      assert(
        input.type === expected,
        `call target argument ${index} must be ${expected}, got ${input.type}`
      );
    }

    this.inputs = target.kind === "direct"
      ? this.arguments
      : [...this.arguments, target.elementIndex];
  }

  static create({ target, arguments: inputs }: InvocationArgs): Invocation {
    return new Invocation(target, inputs);
  }
}
