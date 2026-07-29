export type {
  AnyInteger,
  AnyI32Integer,
  AnyValueHandle,
  IntegerLiteral,
  IntegerOperand,
  BitValue,
  Integer,
  ExtensionTargets,
  I32Handle,
  I32Value,
  I64Handle,
  I64Value,
  ShiftCount,
  SignedView,
  TruncationTargets,
  UnsignedView,
  ValueFor,
  ValueTuple
} from "./values/integer/types.js";

export type { CarrierTypeForWidth } from "#compiler/integer/width.js";
export type { ValueHandle } from "./values/handle.js";

export { integer, i8, i16, i32, i64, u8, u16 } from "./values/integer/constants.js";

export { nonzero, select, unreachable } from "./values/integer/primitives.js";
