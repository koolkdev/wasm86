import type { FloatWidth } from "#compiler/function/values/float/types.js";
import type { Float as FloatValue } from "./values/float/value.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { Integer as IntegerValue } from "./values/integer/types.js";
import { Float as floatTypes, Integer as integerTypes } from "./values/type.js";

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
export type { FloatOperand } from "./values/float/value.js";
export type { FloatWidth } from "./values/float/types.js";
export type {
  AnyValue,
  FloatType,
  IntegerType,
  ValueForType,
  ValueTuple,
  ValueType
} from "./values/type.js";

export const Float = floatTypes;
export type Float<Width extends FloatWidth> = FloatValue<Width>;
export const Integer = integerTypes;
export type Integer<Width extends IntegerWidth> = IntegerValue<Width>;
export { sameValueType, valueTypeOf } from "./values/type.js";

export type { ValueRef } from "./values/expression.js";

export { f32, f64 } from "./values/float/value.js";
export { integer, i32, i64, u8, u16 } from "./values/integer/constants.js";
export { nonzero, unreachable } from "./values/integer/value.js";
export { select } from "./values/select.js";
