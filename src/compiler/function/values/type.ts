import type { FloatWidth } from "#compiler/function/values/float/types.js";
import type { Float as FloatValue } from "#compiler/function/values/float/value.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { Integer as IntegerValue } from "./integer/types.js";
import type { ValueRef } from "./expression.js";

const valueTypeBrand = Symbol("valueType");

export type IntegerType<Width extends IntegerWidth = IntegerWidth> = Readonly<{
  [valueTypeBrand]: true;
  kind: "integer";
  width: Width;
}>;

export type FloatType<Width extends FloatWidth = FloatWidth> = Readonly<{
  [valueTypeBrand]: true;
  kind: "float";
  width: Width;
}>;

export const Integer = {
  1: integerType(1),
  8: integerType(8),
  16: integerType(16),
  32: integerType(32),
  64: integerType(64)
} as const satisfies Readonly<Record<IntegerWidth, IntegerType>>;

export const Float = {
  32: floatType(32),
  64: floatType(64)
} as const satisfies Readonly<Record<FloatWidth, FloatType>>;

export type ValueType = IntegerType | FloatType;

export function sameValueType(a: ValueType, b: ValueType): boolean {
  return a.kind === b.kind && a.width === b.width;
}

export type ValueForType<Type extends ValueType> =
  Type extends IntegerType<infer Width>
    ? Width extends IntegerWidth
      ? IntegerValue<Width>
      : never
    : Type extends FloatType<infer Width>
      ? Width extends FloatWidth
        ? FloatValue<Width>
        : never
      : never;

export type ValueTuple<Types extends readonly ValueType[]> = {
  readonly [Index in keyof Types]: Types[Index] extends ValueType
    ? ValueForType<Types[Index]>
    : never;
};

export type AnyValue = ValueForType<ValueType>;

export function valueTypeOf(value: ValueRef): ValueType {
  switch (value.kind) {
    case "integer":
      return Integer[value.width];
    case "float":
      return Float[value.width];
  }
}

function floatType<Width extends FloatWidth>(width: Width): FloatType<Width> {
  return {
    [valueTypeBrand]: true,
    kind: "float",
    width
  };
}

function integerType<Width extends IntegerWidth>(width: Width): IntegerType<Width> {
  return {
    [valueTypeBrand]: true,
    kind: "integer",
    width
  };
}
