import { assert } from "#common/assert.js";
import { i32 } from "#x86/numeric.js";

export type ValueId = number;

// Nodes reference children by ValueId only; there is no nested-tree form.
// Later stages extend this union with leaf and operator nodes.
export type ConstValueNode = Readonly<{ kind: "const"; value: number }>;
export type ValueNode = ConstValueNode;

export type ValueTable = Readonly<{
  internConst(value: number): ValueId;
  node(id: ValueId): ValueNode;
  size(): number;
}>;

export function createValueTable(): ValueTable {
  const nodes: ValueNode[] = [];
  const constIds = new Map<number, ValueId>();

  return {
    internConst(value: number): ValueId {
      const canonical = i32(value);
      const existing = constIds.get(canonical);

      if (existing !== undefined) {
        return existing;
      }

      const id = nodes.length;
      const node: ValueNode = { kind: "const", value: canonical };

      nodes.push(Object.freeze(node));
      constIds.set(canonical, id);
      return id;
    },
    node(id: ValueId): ValueNode {
      const node = nodes[id];

      assert(node !== undefined, `unknown value id ${id}`);
      return node;
    },
    size(): number {
      return nodes.length;
    }
  };
}
