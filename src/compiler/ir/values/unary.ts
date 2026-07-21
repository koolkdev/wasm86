import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { ValueDefinition } from "./definition.js";
import type { ValueId, WidthBounds } from "./types.js";
import { fitsUnsigned, unboundedWidthBounds } from "./width-bounds.js";

type UnaryDefinition = Readonly<{
  evaluate(value: number): number;
  bounds: WidthBounds;
  emit(body: WasmFunctionBodyEncoder): void;
}>;

export type UnaryOperator = "popcnt" | "ctz" | "clz" | "eqz";

const unaryOperators: Readonly<Record<UnaryOperator, UnaryDefinition>> = {
  popcnt: {
    evaluate: (value) => {
      let remaining = value >>> 0;
      let count = 0;

      while (remaining !== 0) {
        remaining &= remaining - 1;
        count += 1;
      }

      return count;
    },
    bounds: unboundedWidthBounds,
    emit: (body) => body.i32Popcnt()
  },
  ctz: {
    evaluate: (value) => {
      const unsigned = value >>> 0;

      return unsigned === 0 ? 32 : 31 - Math.clz32(unsigned & -unsigned);
    },
    bounds: fitsUnsigned(6),
    emit: (body) => body.i32Ctz()
  },
  clz: {
    evaluate: Math.clz32,
    bounds: fitsUnsigned(6),
    emit: (body) => body.i32Clz()
  },
  eqz: {
    evaluate: (value) => value === 0 ? 1 : 0,
    bounds: fitsUnsigned(1),
    emit: (body) => body.i32Eqz()
  }
};

type UnaryArgs = Readonly<{ operator: UnaryOperator; value: ValueId }>;
type UnaryNode = Readonly<UnaryArgs & { kind: "unary" }>;

export const unaryValue: ValueDefinition<UnaryArgs, UnaryNode> = {
  create: ({ operator, value }) => ({ kind: "unary", operator, value }),
  identity: {
    kind: "scoped",
    key: (node) => [node.operator, node.value]
  },
  inputs: (node) => [{ value: node.value, type: "i32" }],
  resultType: () => "i32",
  widthBounds: (node) => unaryOperators[node.operator].bounds,
  fold: (node, context) => {
    const constant = context.constValue(node.value);

    return constant === undefined
      ? undefined
      : context.constant(unaryOperators[node.operator].evaluate(constant));
  },
  captureMode: "compute",
  emit: (_id, node, target) => unaryOperators[node.operator].emit(target.body)
};
