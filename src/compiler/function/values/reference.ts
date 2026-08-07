import type { FloatWidth } from "#compiler/function/values/float/type.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { ValueRecord } from "./record.js";

export const valueRecord = Symbol("valueRecord");

interface TypedValueRef<Kind extends string, Width extends number> {
  readonly kind: Kind;
  readonly width: Width;
  [valueRecord](): ValueRecord;
}

export type IntegerRef<Width extends IntegerWidth = IntegerWidth> = TypedValueRef<"integer", Width>;

export type FloatRef<Width extends FloatWidth = FloatWidth> = TypedValueRef<"float", Width>;

// The machinery protocol is a real discriminated union. Width-specific code
// asks for the corresponding branch rather than filtering this union.
export type ValueRef = IntegerRef | FloatRef;

export type ValueKind = ValueRef["kind"];
