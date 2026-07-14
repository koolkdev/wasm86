import type { OperandWidth } from "#core/types.js";
import type { BinaryOperator } from "./binary.js";
import type { CompareOperator } from "./comparison.js";
import type { ValueId } from "./types.js";
import type { UnaryOperator } from "./unary.js";

export interface ValueBuilder {
  const(value: number): ValueId;
  const64(value: bigint): ValueId;
  binary(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId;
  unary(operator: UnaryOperator, value: ValueId): ValueId;
  select(condition: ValueId, whenTrue: ValueId, whenFalse: ValueId): ValueId;
  truncate(width: OperandWidth, value: ValueId): ValueId;
  extend(width: OperandWidth, value: ValueId, signed: boolean): ValueId;
  compare(width: OperandWidth, operator: CompareOperator, a: ValueId, b: ValueId): ValueId;
  binary64(operator: BinaryOperator, a: ValueId, b: ValueId): ValueId;
  compare64(operator: CompareOperator, a: ValueId, b: ValueId): ValueId;
  truncate64(width: OperandWidth, value: ValueId): ValueId;
  extend64(width: OperandWidth, value: ValueId, signed: boolean): ValueId;
}
