import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/ir/function.js";
import type { IrFunction } from "#compiler/ir/function.js";
import type { CallTarget } from "#compiler/ir/invocation.js";
import type { Region } from "#compiler/ir/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { RegionBuilder } from "./region.js";

export class FunctionBuilder {
  readonly values = new ValueTable();
  readonly region: RegionBuilder;
  readonly parameters: readonly ValueId[];
  readonly #type: FunctionType;
  #finished = false;

  constructor(type: FunctionType) {
    assert(
      type.results.length <= 1,
      `functions with ${type.results.length} results are not supported yet`
    );
    this.#type = type;
    this.region = new RegionBuilder(this.values, undefined, type.results);
    this.parameters = type.parameters.map((parameterType, index) =>
      this.values.parameter(index, parameterType)
    );
  }

  return(results: readonly ValueId[]): void {
    this.region.return(results);
  }

  returnCall(target: CallTarget, args: readonly ValueId[]): void {
    this.region.returnCall(target, args);
  }

  finish(): IrFunction {
    assert(!this.#finished, "cannot finish a function twice");
    this.#finished = true;
    return {
      type: this.#type,
      parameters: [...this.parameters],
      body: snapshotRegion(this.region.build()),
      values: this.values.fork()
    };
  }
}

export function buildFunction(
  type: FunctionType,
  build: (fn: FunctionBuilder) => void
): IrFunction {
  const fn = new FunctionBuilder(type);

  build(fn);
  return fn.finish();
}

function snapshotRegion(region: Region): Region {
  const nodes = region.nodes.map((node) => node.mapBodies(snapshotRegion));

  return region.result === undefined
    ? { nodes }
    : { nodes, result: region.result };
}
