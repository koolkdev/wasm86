import type { ValueId } from "#compiler/ir/value.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import type { ValueResolutionContext } from "./expression.js";

export const resolveValue = Symbol("resolveValue");

export interface ValueHandle<Type extends ValueType> {
  readonly type: Type;
  [resolveValue](context: ValueResolutionContext): ValueId;
}

export type I32Handle = ValueHandle<"i32">;
export type I64Handle = ValueHandle<"i64">;
export type AnyValueHandle = I32Handle | I64Handle;
