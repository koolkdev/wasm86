import type { FunctionType } from "#compiler/function/type.js";
import type { ValueTuple } from "#compiler/function/values.js";
import type { ValueResolver } from "#compiler/function/values/resolver.js";
import type { Region } from "./region.js";

export type FunctionBody<Type extends FunctionType = FunctionType> = Readonly<{
  type: Type;
  parameters: ValueTuple<Type["parameters"]>;
  entry: Region;
  values: ValueResolver;
}>;
