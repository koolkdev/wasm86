import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { ValueDefinition } from "./definition.js";
import type { ValueId, ValueType } from "./types.js";
import { fitsUnsigned } from "./width-bounds.js";

type ComparisonDefinition = Readonly<{
  evaluate(a: number, b: number): boolean;
  same: boolean;
  signed: boolean;
  emitI32(body: WasmFunctionBodyEncoder): void;
  emitI64(body: WasmFunctionBodyEncoder): void;
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
    signed: false,
    emitI32: (body) => body.i32Eq(),
    emitI64: (body) => body.i64Eq()
  },
  ne: {
    evaluate: (a, b) => a !== b,
    same: false,
    signed: false,
    emitI32: (body) => body.i32Ne(),
    emitI64: (body) => body.i64Ne()
  },
  lt_u: {
    evaluate: (a, b) => (a >>> 0) < (b >>> 0),
    same: false,
    signed: false,
    emitI32: (body) => body.i32LtU(),
    emitI64: (body) => body.i64LtU()
  },
  le_u: {
    evaluate: (a, b) => (a >>> 0) <= (b >>> 0),
    same: true,
    signed: false,
    emitI32: (body) => body.i32LeU(),
    emitI64: (body) => body.i64LeU()
  },
  gt_u: {
    evaluate: (a, b) => (a >>> 0) > (b >>> 0),
    same: false,
    signed: false,
    emitI32: (body) => body.i32GtU(),
    emitI64: (body) => body.i64GtU()
  },
  ge_u: {
    evaluate: (a, b) => (a >>> 0) >= (b >>> 0),
    same: true,
    signed: false,
    emitI32: (body) => body.i32GeU(),
    emitI64: (body) => body.i64GeU()
  },
  lt_s: {
    evaluate: (a, b) => a < b,
    same: false,
    signed: true,
    emitI32: (body) => body.i32LtS(),
    emitI64: (body) => body.i64LtS()
  },
  le_s: {
    evaluate: (a, b) => a <= b,
    same: true,
    signed: true,
    emitI32: (body) => body.i32LeS(),
    emitI64: (body) => body.i64LeS()
  },
  gt_s: {
    evaluate: (a, b) => a > b,
    same: false,
    signed: true,
    emitI32: (body) => body.i32GtS(),
    emitI64: (body) => body.i64GtS()
  },
  ge_s: {
    evaluate: (a, b) => a >= b,
    same: true,
    signed: true,
    emitI32: (body) => body.i32GeS(),
    emitI64: (body) => body.i64GeS()
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
  internKey: (node) => [node.type, node.operator, node.a, node.b],
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
  captureMode: "compute",
  emit: (_id, node, target) => {
    const definition = comparisons[node.operator];

    switch (node.type) {
      case "i32":
        definition.emitI32(target.body);
        break;
      case "i64":
        definition.emitI64(target.body);
        break;
    }
  }
};

export function compareIsSigned(operator: CompareOperator): boolean {
  return comparisons[operator].signed;
}
