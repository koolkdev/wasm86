import type { FunctionType } from "#compiler/function/type.js";
import type { FunctionValues } from "#compiler/function/values/scope.js";
import type { ValueRef } from "#compiler/function/values.js";
import type { Region } from "./region.js";

export type FunctionBody<Type extends FunctionType = FunctionType> = Readonly<{
  entry: Region;
  values: FunctionValues;
  type: Type;
  parameters: readonly ValueRef[];
}>;
