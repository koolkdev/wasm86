import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/ir/function.js";
import type { IrFunction } from "#compiler/ir/function.js";
import type { CallTarget } from "#compiler/ir/invocation.js";
import type { Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { RegionBuilder } from "./region.js";

export type FunctionBuilder = Readonly<{
  values: ValueTable;
  region: RegionBuilder;
  parameters: readonly ValueId[];
  return(results: readonly ValueId[]): void;
  returnCall(target: CallTarget, args: readonly ValueId[]): void;
}>;

export function buildFunction(
  type: FunctionType,
  build: (fn: FunctionBuilder) => void
): IrFunction {
  assert(
    type.results.length <= 1,
    `functions with ${type.results.length} results are not supported yet`
  );
  const values = new ValueTable();
  const region = new RegionBuilder(values, undefined, type.results);
  const parameters = type.parameters.map((parameterType, index) =>
    values.parameter(index, parameterType)
  );
  const fn: FunctionBuilder = {
    values,
    region,
    parameters,
    return: (results) => region.return(results),
    returnCall: (target, args) => region.returnCall(target, args)
  };

  build(fn);
  return {
    type,
    parameters: [...parameters],
    body: snapshotRegion(region.build()),
    values: values.fork()
  };
}

function snapshotRegion(region: Region): Region {
  const nodes = region.nodes.map((node) => node.mapBodies(snapshotRegion));

  return region.result === undefined
    ? { nodes }
    : { nodes, result: region.result };
}
