import {
  exprBinary,
  exprCompare,
  exprConst,
  exprProject,
  exprSelect,
  exprUnary
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type {
  ExprRef,
  ScalarBinaryOp,
  ScalarCompareOp,
  ScalarUnaryOp
} from "#ir/expr/types.js";
import type {
  ValueRef,
  VarId,
  VarRef
} from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";

export type BlockValueBindings =
  | ReadonlyMap<VarId, ExprRef>
  | readonly (readonly [VarId, ExprRef])[];

export type BlockExternalValueResolver = (value: ValueRef) => ExprRef | undefined;

export class BlockValueScope {
  readonly #values = new Map<VarId, ExprRef>();
  readonly #external: BlockExternalValueResolver | undefined;

  constructor(
    values: BlockValueBindings | undefined,
    external: BlockExternalValueResolver | undefined
  ) {
    this.#external = external;

    if (values !== undefined) {
      for (const [id, value] of values) {
        this.#values.set(id, canonicalizeExpr(value));
      }
    }
  }

  bind(dst: VarRef, value: ExprRef): void {
    this.#values.set(dst.id, canonicalizeExpr(value));
  }

  value(value: ValueRef, opIndex: number): ExprRef {
    switch (value.kind) {
      case "const":
        return exprConst(value.value);
      case "var": {
        const local = this.#values.get(value.id);

        if (local !== undefined) {
          return local;
        }

        return this.#externalValue(value, opIndex);
      }
      case "nextEip":
        return this.#externalValue(value, opIndex);
    }
  }

  #externalValue(value: ValueRef, opIndex: number): ExprRef {
    const resolved = this.#external?.(value);

    if (resolved === undefined) {
      throw new Error(`cannot resolve ${value.kind} value at op ${opIndex}`);
    }

    return canonicalizeExpr(resolved);
  }
}

export function blockBinaryExpr(
  op: ScalarBinaryOp,
  left: ExprRef,
  right: ExprRef
): ExprRef {
  return canonicalizeExpr(exprBinary(op, left, right));
}

export function blockUnaryExpr(op: ScalarUnaryOp, value: ExprRef): ExprRef {
  return canonicalizeExpr(exprUnary(op, value));
}

export function blockSelectExpr(
  condition: ExprRef,
  whenTrue: ExprRef,
  whenFalse: ExprRef
): ExprRef {
  return canonicalizeExpr(exprSelect(condition, whenTrue, whenFalse));
}

export function blockProjectExpr(width: OperandWidth, value: ExprRef): ExprRef {
  return canonicalizeExpr(exprProject(width, value));
}

export function blockCompareExpr(
  width: OperandWidth,
  op: ScalarCompareOp,
  left: ExprRef,
  right: ExprRef
): ExprRef {
  return canonicalizeExpr(exprCompare(width, op, left, right));
}
