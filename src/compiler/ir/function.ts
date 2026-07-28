import type { ValueId, ValueType } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { Region } from "./region.js";

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

export type FunctionGraph = Readonly<{
  body: Region;
  values: ValueTable;
}>;

export type IrFunction = FunctionGraph &
  Readonly<{
    type: FunctionType;
    parameters: readonly ValueId[];
  }>;
