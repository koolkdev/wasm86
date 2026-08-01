import { returnControl } from "#compiler/ir/controls/index.js";
import { functionType, type FunctionGraph, type IrFunction } from "#compiler/ir/function.js";
import type { ValueId, ValueType } from "#compiler/ir/values/types.js";

export function completedPlacementFunction(
  graph: FunctionGraph,
  parameterCount = 0,
  returned: readonly ValueId[] = []
): IrFunction {
  const parameters = Array.from({ length: parameterCount }, (_, index) =>
    graph.values.parameter(index, "i32")
  );

  return {
    ...graph,
    body: {
      ...graph.body,
      nodes: [
        ...graph.body.nodes,
        returnControl.create({
          source: { kind: "values", values: returned }
        })
      ]
    },
    type: functionType(
      parameters.map(() => "i32"),
      returned.map((value) => graph.values.valueType(value))
    ),
    parameters
  };
}

export function terminalPlacementFunction(
  graph: FunctionGraph,
  parameterCount: number,
  results: readonly ValueType[]
): IrFunction {
  const parameters = Array.from({ length: parameterCount }, (_, index) =>
    graph.values.parameter(index, "i32")
  );

  return {
    ...graph,
    type: functionType(
      parameters.map(() => "i32"),
      results
    ),
    parameters
  };
}
