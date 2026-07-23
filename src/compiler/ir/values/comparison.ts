import type { ValueDefinition } from "./definition.js";
import type { ValueId, ValueType } from "./types.js";
import { fitsUnsigned } from "./width-bounds.js";

type ComparisonDefinition = Readonly<{
  evaluate(a: number, b: number): boolean;
  same: boolean;
  signed: boolean;
}>;

export type CompareOperator =
  | "eq"
  | "ne"
  | "lt_u"
  | "le_u"
  | "gt_u"
  | "ge_u"
  | "lt_s"
  | "le_s"
  | "gt_s"
  | "ge_s";

const comparisons: Readonly<Record<CompareOperator, ComparisonDefinition>> = {
  eq: {
    evaluate: (a, b) => a === b,
    same: true,
    signed: false
  },
  ne: {
    evaluate: (a, b) => a !== b,
    same: false,
    signed: false
  },
  lt_u: {
    evaluate: (a, b) => (a >>> 0) < (b >>> 0),
    same: false,
    signed: false
  },
  le_u: {
    evaluate: (a, b) => (a >>> 0) <= (b >>> 0),
    same: true,
    signed: false
  },
  gt_u: {
    evaluate: (a, b) => (a >>> 0) > (b >>> 0),
    same: false,
    signed: false
  },
  ge_u: {
    evaluate: (a, b) => (a >>> 0) >= (b >>> 0),
    same: true,
    signed: false
  },
  lt_s: {
    evaluate: (a, b) => a < b,
    same: false,
    signed: true
  },
  le_s: {
    evaluate: (a, b) => a <= b,
    same: true,
    signed: true
  },
  gt_s: {
    evaluate: (a, b) => a > b,
    same: false,
    signed: true
  },
  ge_s: {
    evaluate: (a, b) => a >= b,
    same: true,
    signed: true
  }
};

type ComparisonArgs = Readonly<{
  type: ValueType;
  operator: CompareOperator;
  a: ValueId;
  b: ValueId;
}>;

type ComparisonNode = Readonly<ComparisonArgs & { kind: "compare" }>;

export const comparisonValue: ValueDefinition<ComparisonArgs, ComparisonNode> = {
  create: ({ type, operator, a, b }) => ({ kind: "compare", type, operator, a, b }),
  identity: {
    kind: "scoped",
    key: (node) => [node.type, node.operator, node.a, node.b]
  },
  inputs: (node) => [
    { value: node.a, type: node.type },
    { value: node.b, type: node.type }
  ],
  resultType: () => "i32",
  widthBounds: () => fitsUnsigned(1),
  fold: (node, context) => {
    const definition = comparisons[node.operator];
    const left = context.constValue(node.a);
    const right = context.constValue(node.b);

    if (left !== undefined && right !== undefined) {
      return context.constant(definition.evaluate(left, right) ? 1 : 0);
    }

    if (node.type === "i32" && node.operator === "eq") {
      if (left === 0) {
        return context.eqz(node.b);
      }

      if (right === 0) {
        return context.eqz(node.a);
      }
    }

    return node.a === node.b
      ? context.constant(definition.same ? 1 : 0)
      : undefined;
  },
  captureMode: "compute"
};

export function compareIsSigned(operator: CompareOperator): boolean {
  return comparisons[operator].signed;
}
