import { functionType, type FunctionType } from "#compiler/ir/function-type.js";
import { Integer, type IntegerType } from "#compiler/ir/values.js";

const exactType = functionType([Integer[8], Integer[64]], [Integer[1]]);

export const typedFunction: FunctionType<
  readonly [IntegerType<8>, IntegerType<64>],
  readonly [IntegerType<1>]
> = exactType;
export const parameterWidth: 8 = exactType.parameters[0].width;
export const resultWidth: 1 = exactType.results[0].width;

type WrongWidth = FunctionType<
  readonly [IntegerType<32>, IntegerType<64>],
  readonly [IntegerType<1>]
>;

// @ts-expect-error logical byte and dword parameters are distinct types.
export const wrongWidth: WrongWidth = exactType;

// @ts-expect-error Wasm carrier spellings are not logical IR types.
functionType(["i32"], []);
