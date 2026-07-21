import type { ValueType } from "#compiler/ir/values/types.js";

declare const functionTypeBrand: unique symbol;

export type FunctionType = Readonly<{
  [functionTypeBrand]: true;
  parameters: readonly ValueType[];
  results: readonly ValueType[];
}>;

export function functionType(
  parameters: readonly ValueType[],
  results: readonly ValueType[]
): FunctionType {
  return {
    parameters: [...parameters],
    results: [...results]
  } as unknown as FunctionType;
}
