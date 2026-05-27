import type { ExprRef } from "#ir/expr/types.js";
import type {
  IrBinaryOperator,
  IrCompareOperator,
  IrUnaryOperator,
  IrValueType,
  ValueRef,
  VarRef
} from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";
import {
  BlockValueScope,
  blockBinaryExpr,
  blockCompareExpr,
  blockProjectExpr,
  blockSelectExpr,
  blockUnaryExpr,
  type BlockExternalValueResolver,
  type BlockValueBindings
} from "./values.js";

export class ValueWalkOps {
  readonly #values: BlockValueScope;
  readonly #opIndex: () => number;

  constructor(input: Readonly<{
    values: BlockValueBindings | undefined;
    value: BlockExternalValueResolver | undefined;
    opIndex: () => number;
  }>) {
    this.#values = new BlockValueScope(input.values, input.value);
    this.#opIndex = input.opIndex;
  }

  bind(dst: VarRef, value: ExprRef): void {
    this.#values.bind(dst, value);
  }

  resolve(value: ValueRef): ExprRef {
    return this.#values.value(value, this.#opIndex());
  }

  constant(type: IrValueType, value: number): ExprRef {
    return this.resolve({ kind: "const", type, value });
  }

  binary(operator: IrBinaryOperator, a: ValueRef, b: ValueRef): ExprRef {
    return blockBinaryExpr(operator, this.resolve(a), this.resolve(b));
  }

  unary(operator: IrUnaryOperator, value: ValueRef): ExprRef {
    return blockUnaryExpr(operator, this.resolve(value));
  }

  select(condition: ValueRef, whenTrue: ValueRef, whenFalse: ValueRef): ExprRef {
    return blockSelectExpr(
      this.resolve(condition),
      this.resolve(whenTrue),
      this.resolve(whenFalse)
    );
  }

  project(width: OperandWidth, value: ValueRef): ExprRef {
    return blockProjectExpr(width, this.resolve(value));
  }

  compare(
    width: OperandWidth,
    operator: IrCompareOperator,
    a: ValueRef,
    b: ValueRef
  ): ExprRef {
    return blockCompareExpr(width, operator, this.resolve(a), this.resolve(b));
  }
}
