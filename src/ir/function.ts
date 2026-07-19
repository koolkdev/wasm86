import { assert } from "#common/assert.js";
import type { FunctionType } from "#compiler/program/function-type.js";
import type { CallTarget } from "#compiler/ir/invocation.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { Body } from "./block.js";
import { RegionBuilder } from "./region-builder.js";

export type IrFunction = Readonly<{
  type: FunctionType;
  parameters: readonly ValueId[];
  body: Body;
  values: ValueTable;
}>;

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
      body: snapshotBody(this.region.build()),
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

function snapshotBody(body: Body): Body {
  const nodes = body.nodes.map((node) => node.mapBodies(snapshotBody));

  return body.result === undefined ? { nodes } : { nodes, result: body.result };
}
