import type { Operation } from "#compiler/ir/operations/index.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { Control } from "#compiler/ir/controls/index.js";

export type BodyNode = Operation | Control;

// `result` is the fallthrough value a body delivers when its owning control
// declares an output; escaping bodies carry none.
export type Body = Readonly<{
  nodes: readonly BodyNode[];
  result?: ValueId;
}>;

export type IrBlock = Readonly<{
  body: Body;
  values: ValueTable;
}>;

// A control completes its owner when every selectable path escapes. A
// result-bearing body instead falls through to its control's join.
export function nodeCompletes(node: BodyNode): boolean {
  return node.completes({ bodyCompletes });
}

export function bodyCompletes(body: Body): boolean {
  return bodyFinal(body) !== undefined;
}

export function bodyFinal(body: Body): BodyNode | undefined {
  const last = body.nodes[body.nodes.length - 1];

  return last !== undefined && nodeCompletes(last) ? last : undefined;
}
