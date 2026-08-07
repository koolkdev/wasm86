import {
  Float,
  Integer,
  type FloatType,
  type IntegerType,
  type ValueType
} from "#compiler/function/values/type.js";

const functionTypeBrand = Symbol("functionType");

// Signatures are declared from here, so both type vocabularies leave from here.
export { Float, Integer };
export type { FloatType, IntegerType, ValueType };

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
