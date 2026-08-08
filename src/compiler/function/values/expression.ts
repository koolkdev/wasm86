import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator,
  ZeroTestOperator
} from "#compiler/function/values/integer/operators.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";

export const valueExpression = Symbol("valueExpression");

interface TypedValueRef<Kind extends string, Width extends number> {
  readonly kind: Kind;
  readonly width: Width;
  [valueExpression](): ValueExpression;
}

export type IntegerRef<Width extends IntegerWidth = IntegerWidth> = TypedValueRef<"integer", Width>;

export type ValueRef = IntegerRef;

export type ValueKind = ValueRef["kind"];

type ExpressionFieldName = "attr" | "a" | "b" | "c" | "bound";

type ExpressionField<Fields, Name extends ExpressionFieldName> =
  Fields extends Readonly<Record<Name, infer Value>> ? Value : undefined;

type ExpressionShape<
  Kind extends ValueKind,
  Width extends number,
  Operation extends string,
  Fields extends Record<Exclude<keyof Fields, ExpressionFieldName>, never> = {}
> = Readonly<{
  kind: Kind;
  width: Width;
  op: Operation;
  attr: ExpressionField<Fields, "attr">;
  a: ExpressionField<Fields, "a">;
  b: ExpressionField<Fields, "b">;
  c: ExpressionField<Fields, "c">;
  bound: ExpressionField<Fields, "bound">;
}>;

export type IntegerExpression =
  | ExpressionShape<"integer", IntegerWidth, "integer.constant", { attr: bigint }>
  | ExpressionShape<"integer", IntegerWidth, "integer.unreachable">
  | ExpressionShape<
      "integer",
      IntegerWidth,
      "integer.binary",
      { attr: BinaryOperator; a: IntegerRef; b: IntegerRef }
    >
  | ExpressionShape<
      "integer",
      1,
      "integer.compare",
      { attr: CompareOperator; a: IntegerRef; b: IntegerRef }
    >
  | ExpressionShape<"integer", 1, "integer.zeroTest", { attr: ZeroTestOperator; a: IntegerRef }>
  | ExpressionShape<
      "integer",
      IntegerWidth,
      "integer.bitCount",
      { attr: BitCountOperator; a: IntegerRef }
    >
  | ExpressionShape<"integer", IntegerWidth, "integer.extend", { attr: boolean; a: IntegerRef }>
  | ExpressionShape<"integer", IntegerWidth, "integer.truncate", { a: IntegerRef }>
  | ExpressionShape<
      "integer",
      IntegerWidth,
      "integer.select",
      { a: IntegerRef<1>; b: IntegerRef; c: IntegerRef }
    >;

export type ValueExpression = IntegerExpression;
