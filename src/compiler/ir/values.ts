import type { IntegerWidth } from "#compiler/integer/width.js";
import type { Integer as IntegerValue } from "./values/integer/types.js";
import { Integer as integerTypes } from "./values/type.js";

export type {
  AnyInteger,
  AnyNarrowInteger,
  AnyValueHandle,
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

export type { AnyValue, IntegerType, ValueType, ValueTuple } from "./values/type.js";

export const Integer = integerTypes;
export type Integer<Width extends IntegerWidth> = IntegerValue<Width>;
export { sameValueType, valueTypeOf } from "./values/type.js";

export type { ValueHandle } from "./values/handle.js";

export { integer, i8, i16, i32, i64, u8, u16 } from "./values/integer/constants.js";

export { nonzero, select, unreachable } from "./values/integer/primitives.js";
