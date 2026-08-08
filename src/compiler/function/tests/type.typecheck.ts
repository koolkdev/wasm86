import { functionType, type FunctionType } from "#compiler/function/type.js";
import {
  Integer,
  type Integer as IntegerValue,
  type IntegerType,
  type ValueTuple
} from "#compiler/function/values.js";

const exactType = functionType([Integer[8], Integer[64]], [Integer[1]]);

export const typedFunction: FunctionType<
  readonly [IntegerType<8>, IntegerType<64>],
  readonly [IntegerType<1>]
> = exactType;

type Equal<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends <Type>() => Type extends Right ? 1 : 2
    ? true
    : false;
type Expect<Type extends true> = Type;

export type ParameterValuesContract = Expect<
  Equal<ValueTuple<typeof exactType.parameters>, readonly [IntegerValue<8>, IntegerValue<64>]>
>;

type WrongWidth = FunctionType<
  readonly [IntegerType<32>, IntegerType<64>],
  readonly [IntegerType<1>]
>;

// @ts-expect-error logical byte and dword parameters are distinct types.
export const wrongWidth: WrongWidth = exactType;

// @ts-expect-error function signatures expose immutable parameter tuples.
exactType.parameters.push(Integer[32]);

// @ts-expect-error function signatures expose immutable result tuples.
exactType.results.push(Integer[32]);

// @ts-expect-error Wasm carrier spellings are not logical value types.
functionType(["i32"], []);
