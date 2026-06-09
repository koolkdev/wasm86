import { assert } from "#common/assert.js";
import {
  get2,
  get3,
  get4,
  put2,
  put3,
  put4,
  type Map2,
  type Map3,
  type Map4
} from "#common/nested-map.js";
import type { IrBinaryOperator, IrCompareOperator, IrUnaryOperator } from "#ir/model/types.js";
import { i32 } from "#x86/numeric.js";
import type { OperandWidth } from "#x86/types.js";
import type { ExternalValueId } from "./operands.js";

export type ValueId = number;

// Nodes reference children by ValueId only; there is no nested-tree form.
// Actions are not expressions: a readState/readMemory output enters the
// graph as an actionOutput leaf.
export type ConstValueNode = Readonly<{ kind: "const"; value: number }>;
export type ActionOutputValueNode = Readonly<{ kind: "actionOutput" }>;
export type ExternalValueNode = Readonly<{ kind: "external"; external: ExternalValueId }>;
export type BinaryValueNode = Readonly<{
  kind: "binary";
  operator: IrBinaryOperator;
  a: ValueId;
  b: ValueId;
}>;
export type UnaryValueNode = Readonly<{ kind: "unary"; operator: IrUnaryOperator; value: ValueId }>;
export type CompareValueNode = Readonly<{
  kind: "compare";
  width: OperandWidth;
  operator: IrCompareOperator;
  a: ValueId;
  b: ValueId;
}>;
export type SelectValueNode = Readonly<{
  kind: "select";
  condition: ValueId;
  whenTrue: ValueId;
  whenFalse: ValueId;
}>;
export type ProjectValueNode = Readonly<{ kind: "project"; width: OperandWidth; value: ValueId }>;

export type ValueNode =
  | ConstValueNode
  | ActionOutputValueNode
  | ExternalValueNode
  | BinaryValueNode
  | UnaryValueNode
  | CompareValueNode
  | SelectValueNode
  | ProjectValueNode;

export type ValueTable = Readonly<{
  internConst(value: number): ValueId;
  internExternal(external: ExternalValueId): ValueId;
  addActionOutput(): ValueId;
  internBinary(operator: IrBinaryOperator, a: ValueId, b: ValueId): ValueId;
  internUnary(operator: IrUnaryOperator, value: ValueId): ValueId;
  internCompare(width: OperandWidth, operator: IrCompareOperator, a: ValueId, b: ValueId): ValueId;
  internSelect(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId;
  internProject(width: OperandWidth, value: ValueId): ValueId;
  node(id: ValueId): ValueNode;
  // References from other nodes in this table; action and region uses are
  // the consumer's to count.
  useCount(id: ValueId): number;
  size(): number;
}>;

export function createValueTable(): ValueTable {
  const nodes: ValueNode[] = [];
  const useCounts: number[] = [];
  const constIds = new Map<number, ValueId>();
  const externalIds = new Map<ExternalValueId, ValueId>();
  const binaryIds: Map3<IrBinaryOperator, ValueId, ValueId, ValueId> = new Map();
  const unaryIds: Map2<IrUnaryOperator, ValueId, ValueId> = new Map();
  const compareIds: Map4<OperandWidth, IrCompareOperator, ValueId, ValueId, ValueId> = new Map();
  const selectIds: Map3<ValueId, ValueId, ValueId, ValueId> = new Map();
  const projectIds: Map2<OperandWidth, ValueId, ValueId> = new Map();

  function add(node: ValueNode, children: readonly ValueId[]): ValueId {
    for (const child of children) {
      assert(nodes[child] !== undefined, `unknown value id ${child}`);
    }

    const id = nodes.length;

    nodes.push(Object.freeze(node));
    useCounts.push(0);

    for (const child of children) {
      useCounts[child]! += 1;
    }

    return id;
  }

  return {
    internConst(value: number): ValueId {
      const canonical = i32(value);
      const existing = constIds.get(canonical);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "const", value: canonical }, []);

      constIds.set(canonical, id);
      return id;
    },
    internExternal(external: ExternalValueId): ValueId {
      const existing = externalIds.get(external);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "external", external }, []);

      externalIds.set(external, id);
      return id;
    },
    addActionOutput(): ValueId {
      // Each action produces a distinct value; outputs are never deduped.
      return add({ kind: "actionOutput" }, []);
    },
    internBinary(operator: IrBinaryOperator, a: ValueId, b: ValueId): ValueId {
      const existing = get3(binaryIds, operator, a, b);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "binary", operator, a, b }, [a, b]);

      put3(binaryIds, operator, a, b, id);
      return id;
    },
    internUnary(operator: IrUnaryOperator, value: ValueId): ValueId {
      const existing = get2(unaryIds, operator, value);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "unary", operator, value }, [value]);

      put2(unaryIds, operator, value, id);
      return id;
    },
    internCompare(width: OperandWidth, operator: IrCompareOperator, a: ValueId, b: ValueId): ValueId {
      const existing = get4(compareIds, width, operator, a, b);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "compare", width, operator, a, b }, [a, b]);

      put4(compareIds, width, operator, a, b, id);
      return id;
    },
    internSelect(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId {
      const existing = get3(selectIds, condition, whenTrue, whenFalse);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "select", condition, whenTrue, whenFalse }, [
        condition,
        whenTrue,
        whenFalse
      ]);

      put3(selectIds, condition, whenTrue, whenFalse, id);
      return id;
    },
    internProject(width: OperandWidth, value: ValueId): ValueId {
      const existing = get2(projectIds, width, value);

      if (existing !== undefined) {
        return existing;
      }

      const id = add({ kind: "project", width, value }, [value]);

      put2(projectIds, width, value, id);
      return id;
    },
    node(id: ValueId): ValueNode {
      const node = nodes[id];

      assert(node !== undefined, `unknown value id ${id}`);
      return node;
    },
    useCount(id: ValueId): number {
      assert(nodes[id] !== undefined, `unknown value id ${id}`);
      return useCounts[id]!;
    },
    size(): number {
      return nodes.length;
    }
  };
}
