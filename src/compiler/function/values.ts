import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { Integer as IntegerValue } from "./values/integer/types.js";
import { Integer as integerTypes } from "./values/type.js";

export type {
  AnyInteger,
  AnyNarrowInteger,
  BitValue,
  I32Value,
  I64Value,
  TruncationTargets
} from "./values/integer/types.js";
export type { AnyValue, IntegerType, ValueForType, ValueTuple, ValueType } from "./values/type.js";

export const Integer = integerTypes;
export type Integer<Width extends IntegerWidth> = IntegerValue<Width>;
export { sameValueType, valueTypeOf } from "./values/type.js";

export type { ValueRef } from "./values/expression.js";
