import type { I32Value } from "#compiler/ir/values.js";
import type { ValueGraph } from "../node.js";
import type { ValueTable } from "../table.js";

export function valueGraphTypeContract(values: ValueTable, value: I32Value): void {
  const graph: ValueGraph = values;

  graph.size();

  // @ts-expect-error a completed value graph cannot use expressions.
  graph.use(value);
  // @ts-expect-error a completed value graph cannot create child scopes.
  graph.childScope();
}
