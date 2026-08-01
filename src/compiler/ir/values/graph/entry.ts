import type { ValueDefinition } from "./definition.js";
import type { ValueNode } from "./node.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";

const noChildren: readonly ValueId[] = [];

type ValueEntryData<Node extends ValueNode> = Readonly<{
  node: Node;
  children: readonly ValueId[];
  bitWidth: IntegerWidth;
}>;

export type ValueEntry = ValueEntryData<ValueNode> &
  Readonly<{
    constant: bigint | undefined;
  }>;

export function createValueEntry<Args, Node extends ValueNode>(
  definition: ValueDefinition<Args, Node>,
  data: ValueEntryData<Node>
): ValueEntry {
  const { node } = data;

  return {
    ...data,
    children: data.children.length === 0 ? noChildren : data.children,
    constant: definition.constant?.(node)
  };
}
