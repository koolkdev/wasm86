import type { Control } from "#compiler/function/control.js";
import type { Operation } from "#compiler/function/operation.js";
import type { ValueRef } from "#compiler/function/values.js";

export type RegionNode = Operation | Control;

// An if or switch arm may yield one value when execution reaches its end.
// An arm ending with return or loopContinue yields no value.
export type Region = Readonly<{
  nodes: readonly RegionNode[];
  result?: ValueRef;
}>;
