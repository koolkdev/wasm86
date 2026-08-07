import type { FloatWidth } from "#compiler/function/values/float/type.js";
import type { Float as FloatValue } from "#compiler/function/values/float/value.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { Integer as IntegerValue } from "./values/integer/types.js";
import { Float as floatTypes, Integer as integerTypes } from "./values/type.js";

export type {
  AnyInteger,
  AnyNarrowInteger,
  IntegerLiteral,
  IntegerOperand,
  BitValue,
  ExtensionTargets,
  I32Value,
  I64Value,
  ShiftCount,
  SignedView,
  TruncationTargets,
  UnsignedView
} from "./values/integer/types.js";
export type {
  AnyValue,
  FloatType,
  IntegerType,
  ValueType,
  ValueForType,
  ValueTuple
} from "./values/type.js";

export const Integer = integerTypes;
export type Integer<Width extends IntegerWidth> = IntegerValue<Width>;
export const Float = floatTypes;
export type Float<Width extends FloatWidth> = FloatValue<Width>;
export { sameValueType, valueTypeOf } from "./values/type.js";

export type { ValueRef } from "./values/reference.js";

export { integer, i32, i64, u8, u16 } from "./values/integer/constants.js";

export type { FloatWidth } from "#compiler/function/values/float/type.js";
export type { FloatOperand } from "#compiler/function/values/float/value.js";
export { f32, f64 } from "#compiler/function/values/float/value.js";

export { nonzero, unreachable } from "./values/integer/primitives.js";
export { select } from "./values/select.js";
