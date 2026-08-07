import { assert } from "#common/assert.js";
import type { FunctionType, ValueType } from "#compiler/function/type.js";
import type { FunctionBody } from "#compiler/function/body.js";
import type { CallTarget } from "#compiler/function/invocation.js";
import { ValueScope } from "#compiler/function/values/scope.js";
import type { ValueTuple } from "#compiler/function/values.js";
import { RegionBuilder } from "./region.js";

export type FunctionBuilder<Type extends FunctionType> = Readonly<{
  region: RegionBuilder;
  parameters: ValueTuple<Type["parameters"]>;
  return: (results: ValueTuple<Type["results"]>) => void;
  returnCall: <TargetType extends FunctionType<readonly ValueType[], Type["results"]>>(
    target: CallTarget<TargetType>,
    args: ValueTuple<NoInfer<TargetType["parameters"]>>
  ) => void;
}>;

export function buildFunction<Type extends FunctionType>(
  type: Type,
  build: (fn: FunctionBuilder<Type>) => void
): FunctionBody<Type> {
  assert(
    type.results.length <= 1,
    `functions with ${type.results.length} results are not supported yet`
  );
  const values = new ValueScope();
  const region = new RegionBuilder(values, {
    functionResults: type.results
  });
  const parameters = values.parameters<Type["parameters"]>(type.parameters);
  const fn: FunctionBuilder<Type> = {
    region,
    parameters,
    return: (results) => region.return(results),
    returnCall: (target, args) => region.returnCall(target, args)
  };

  build(fn);
  return {
    type,
    parameters,
    entry: region.build(),
    values
  };
}
