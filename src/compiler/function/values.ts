import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { Integer as IntegerValue } from "./values/integer/types.js";
import { Integer as integerTypes } from "./values/type.js";

export type {
  AnyInteger,
  AnyNarrowInteger,
  BitValue,
  ExtensionTargets,
  I32Value,
  I64Value,
  IntegerLiteral,
  IntegerOperand,
  ShiftCount,
  SignedView,
  UnsignedView,
  TruncationTargets
} from "./values/integer/types.js";
export type { AnyValue, IntegerType, ValueForType, ValueTuple, ValueType } from "./values/type.js";

export const Integer = integerTypes;
export type Integer<Width extends IntegerWidth> = IntegerValue<Width>;
export { sameValueType, valueTypeOf } from "./values/type.js";

export type { ValueRef } from "./values/expression.js";

export { integer, i32, i64, u8, u16 } from "./values/integer/constants.js";
export { nonzero, unreachable } from "./values/integer/value.js";
export { select } from "./values/select.js";
