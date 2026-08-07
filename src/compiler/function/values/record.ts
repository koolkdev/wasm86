import type {
  FloatBinaryOperator,
  FloatCompareOperator
} from "#compiler/function/values/float/type.js";
import type { FloatWidth } from "#compiler/function/values/float/type.js";
import type {
  BinaryOperator,
  BitCountOperator,
  CompareOperator
} from "#compiler/function/values/integer/operators.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { ValueScope } from "./scope.js";
import type { FloatRef, IntegerRef, ValueKind } from "./reference.js";
import type { ValueType } from "./type.js";

export type ZeroTestOperator = "eqz" | "nonzero";

// A value the lowering walk binds at its producing site. The slot object is
// the occurrence identity; the Wasm binding lives in the resolver's memo.
export type ValueSlot = Readonly<{
  source: "parameter" | "producer" | "loopInput";
  type: ValueType;
  index: number;
}>;

// A slot reference also names the value scope that owns it; resolution records
// the pair so later uses can be checked against their scope.
export type ValueScopeRequirement = Readonly<{
  origin: ValueScope;
  slot: ValueSlot;
}>;

// Runtime values keep one fixed field layout per kind. This union is only the
// typed machinery view: an operation tag establishes its attribute vocabulary
// and which operand fields are present. Construction owns width compatibility.
type Record<
  Kind extends ValueKind,
  Width extends number,
  Op extends string,
  Attr,
  A = undefined,
  B = undefined,
  C = undefined,
  Bound = undefined
> = Readonly<{
  kind: Kind;
  width: Width;
  op: Op;
  attr: Attr;
  a: A;
  b: B;
  c: C;
  bound: Bound;
}>;

type FloatConstantRecord =
  Record<"float", 32, "float.constant", number> | Record<"float", 64, "float.constant", bigint>;

export type IntegerRecord =
  | Record<"integer", IntegerWidth, "integer.constant", bigint>
  | Record<"integer", IntegerWidth, "integer.unreachable", undefined>
  | Record<
      "integer",
      IntegerWidth,
      "integer.bound",
      undefined,
      undefined,
      undefined,
      undefined,
      ValueScopeRequirement
    >
  | Record<"integer", IntegerWidth, "integer.binary", BinaryOperator, IntegerRef, IntegerRef>
  | Record<"integer", 1, "integer.compare", CompareOperator, IntegerRef, IntegerRef>
  | Record<"integer", 1, "float.compare", FloatCompareOperator, FloatRef, FloatRef>
  | Record<"integer", 1, "integer.zeroTest", ZeroTestOperator, IntegerRef>
  | Record<"integer", IntegerWidth, "integer.bitCount", BitCountOperator, IntegerRef>
  | Record<"integer", IntegerWidth, "integer.extend", boolean, IntegerRef>
  | Record<"integer", IntegerWidth, "integer.truncate", undefined, IntegerRef>
  | Record<
      "integer",
      IntegerWidth,
      "integer.select",
      undefined,
      IntegerRef<1>,
      IntegerRef,
      IntegerRef
    >;

export type FloatRecord =
  | FloatConstantRecord
  | Record<
      "float",
      FloatWidth,
      "float.bound",
      undefined,
      undefined,
      undefined,
      undefined,
      ValueScopeRequirement
    >
  | Record<"float", FloatWidth, "float.binary", FloatBinaryOperator, FloatRef, FloatRef>
  | Record<"float", FloatWidth, "float.select", undefined, IntegerRef<1>, FloatRef, FloatRef>;

export type ValueRecord = IntegerRecord | FloatRecord;
