import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/function/type.js";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { ValueTuple } from "#compiler/function/values.js";
import type { FunctionRef } from "#compiler/reference.js";

export type CallTarget<Type extends FunctionType = FunctionType> = Readonly<{
  kind: "direct";
  ref: FunctionRef;
  type: Type;
  effects: StorageEffects;
}>;

type InvocationArgs<Type extends FunctionType> = Readonly<{
  target: CallTarget<Type>;
  arguments: ValueTuple<Type["parameters"]>;
}>;

export class Invocation<Type extends FunctionType = FunctionType> {
  readonly arguments: ValueTuple<Type["parameters"]>;

  private constructor(
    readonly target: CallTarget<Type>,
    args: ValueTuple<Type["parameters"]>
  ) {
    this.arguments = args;
    assert(
      this.arguments.length === target.type.parameters.length,
      `call target expects ${target.type.parameters.length} arguments, got ${this.arguments.length}`
    );
  }

  static create<Type extends FunctionType>({
    target,
    arguments: args
  }: InvocationArgs<Type>): Invocation<Type> {
    return new Invocation(target, args);
  }
}
