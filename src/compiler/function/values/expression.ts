import type {
  FloatBinaryOperator,
  FloatCompareOperator,
  FloatWidth
} from "#compiler/function/values/float/types.js";
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

export type FloatRef<Width extends FloatWidth = FloatWidth> = TypedValueRef<"float", Width>;

export type ValueRef = IntegerRef | FloatRef;

export type ValueKind = ValueRef["kind"];

export type ValueSource =
  Readonly<{ kind: "parameter"; index: number }> | Readonly<{ kind: "producer" }>;

type ExpressionFieldName = "attr" | "a" | "b" | "c";

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
}>;

type SourceExpression =
  | ExpressionShape<"integer", IntegerWidth, "value.source", { attr: ValueSource }>
  | ExpressionShape<"float", FloatWidth, "value.source", { attr: ValueSource }>;

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

type FloatConstantExpression =
  | ExpressionShape<"float", 32, "float.constant", { attr: number }>
  | ExpressionShape<"float", 64, "float.constant", { attr: bigint }>;

// Expression families follow their operators; a float comparison produces an integer bit.
export type FloatExpression =
  | FloatConstantExpression
  | ExpressionShape<
      "integer",
      1,
      "float.compare",
      { attr: FloatCompareOperator; a: FloatRef; b: FloatRef }
    >
  | ExpressionShape<
      "float",
      FloatWidth,
      "float.binary",
      { attr: FloatBinaryOperator; a: FloatRef; b: FloatRef }
    >
  | ExpressionShape<
      "float",
      FloatWidth,
      "float.select",
      { a: IntegerRef<1>; b: FloatRef; c: FloatRef }
    >;

export type ValueExpression = SourceExpression | IntegerExpression | FloatExpression;
