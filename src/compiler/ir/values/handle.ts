import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueResolutionContext } from "./expression.js";

export const resolveValue = Symbol("resolveValue");

export interface ValueHandle<Width extends IntegerWidth = IntegerWidth> {
  readonly width: Width;
  [resolveValue](context: ValueResolutionContext): ValueId;
}

export type AnyValueHandle = ValueHandle;
