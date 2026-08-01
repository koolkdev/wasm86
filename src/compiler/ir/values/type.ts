import type { IntegerWidth } from "#compiler/integer/width.js";
import type { Integer as IntegerValue } from "./integer/types.js";

const valueTypeBrand = Symbol("valueType");

export type IntegerType<Width extends IntegerWidth = IntegerWidth> = Readonly<{
  [valueTypeBrand]: true;
  kind: "integer";
  width: Width;
}>;

export const Integer = {
  1: integerType(1),
  8: integerType(8),
  16: integerType(16),
  32: integerType(32),
  64: integerType(64)
} as const satisfies Readonly<Record<IntegerWidth, IntegerType>>;

export type ValueType = (typeof Integer)[IntegerWidth];

export function sameValueType(a: ValueType, b: ValueType): boolean {
  switch (a.kind) {
    case "integer":
      switch (b.kind) {
        case "integer":
          return a.width === b.width;
      }
  }
}

type ValueForType<Type extends ValueType> =
  Type extends IntegerType<infer Width>
    ? Width extends IntegerWidth
      ? IntegerValue<Width>
      : never
    : never;

export type ValueTuple<Types extends readonly ValueType[]> = {
  readonly [Index in keyof Types]: Types[Index] extends ValueType
    ? ValueForType<Types[Index]>
    : never;
};

export type AnyValue = ValueForType<ValueType>;

export function valueTypeOf(value: AnyValue): ValueType {
  switch (value.kind) {
    case "integer":
      return Integer[value.width];
  }
}

function integerType<Width extends IntegerWidth>(width: Width): IntegerType<Width> {
  return {
    [valueTypeBrand]: true,
    kind: "integer",
    width
  };
}
