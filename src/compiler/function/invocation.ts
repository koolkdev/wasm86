import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/function/type.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { FunctionRef } from "#compiler/reference.js";
import type { ValueRef } from "#compiler/function/values.js";

export type CallTarget<Type extends FunctionType = FunctionType> = Readonly<{
  kind: "direct";
  ref: FunctionRef;
  type: Type;
  effects: StorageEffects;
}>;

type InvocationArgs<Type extends FunctionType> = Readonly<{
  target: CallTarget<Type>;
  arguments: readonly ValueRef[];
}>;

// A call's target and value references, independent of how its results are consumed.
// The target's exact logical type owns all argument and result widths.
export class Invocation<Type extends FunctionType = FunctionType> {
  readonly arguments: readonly ValueRef[];

  private constructor(
    readonly target: CallTarget<Type>,
    sourceArguments: readonly ValueRef[]
  ) {
    this.arguments = [...sourceArguments];
    assert(
      this.arguments.length === target.type.parameters.length,
      `call target expects ${target.type.parameters.length} arguments, got ${this.arguments.length}`
    );
  }

  static create<Type extends FunctionType = FunctionType>({
    target,
    arguments: inputs
  }: InvocationArgs<Type>): Invocation<Type> {
    return new Invocation(target, inputs);
  }
}
