import type { ValueType } from "#compiler/value.js";

const functionTypeBrand = Symbol("functionType");

export type FunctionType<
  Parameters extends readonly ValueType[] = readonly ValueType[],
  Results extends readonly ValueType[] = readonly ValueType[]
> = Readonly<{
  [functionTypeBrand]: true;
  parameters: readonly [...Parameters];
  results: readonly [...Results];
}>;

export function functionType<
  const Parameters extends readonly ValueType[],
  const Results extends readonly ValueType[]
>(parameters: Parameters, results: Results): FunctionType<Parameters, Results>;
export function functionType(
  parameters: readonly ValueType[],
  results: readonly ValueType[]
): FunctionType {
  return {
    [functionTypeBrand]: true,
    parameters: [...parameters],
    results: [...results]
  };
}
