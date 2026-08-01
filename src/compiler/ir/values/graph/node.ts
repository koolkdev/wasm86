import type { BinaryNode } from "./binary.js";
import type { BitCountNode } from "./bit-count.js";
import type { ComparisonNode } from "./comparison.js";
import type { ExtendNode } from "./extend.js";
import type {
  ConstantNode,
  LoopInputNode,
  NodeOutputNode,
  ParameterNode,
  UnreachableNode
} from "./leaves.js";
import type { SelectNode } from "./select.js";
import type { TruncateNode } from "./truncate.js";
import type { ZeroTestNode } from "./zero-test.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueType } from "#compiler/ir/values/types.js";

export type ValueNode =
  | BinaryNode
  | BitCountNode
  | ComparisonNode
  | ConstantNode
  | ExtendNode
  | LoopInputNode
  | NodeOutputNode
  | ParameterNode
  | SelectNode
  | TruncateNode
  | UnreachableNode
  | ZeroTestNode;

// Valid IDs are dense in [0, size()) and every child has a lower ID than its
// parent.
export interface ValueGraph {
  node(id: ValueId): ValueNode;
  size(): number;
  children(id: ValueId): readonly ValueId[];
  bitWidth(id: ValueId): IntegerWidth;
  valueType(id: ValueId): ValueType;
  isUnreachable(id: ValueId): boolean;
  constant(id: ValueId): bigint | undefined;
}
