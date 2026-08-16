import type { Control } from "#compiler/function/control.js";
import type { Operation } from "#compiler/function/operation.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { ValueRef } from "#compiler/function/values.js";

export type RegionNode = Operation | Control;

// `result` is delivered to a value-producing owning control when ordinary
// execution reaches the region end. `writtenVariables` includes nested bodies,
// and `fallsThrough` records whether that end is reachable. Loops are
// conservatively treated as possibly exiting.
export type Region = Readonly<{
  nodes: readonly RegionNode[];
  result?: ValueRef;
  writtenVariables: ReadonlySet<VariableRef>;
  fallsThrough: boolean;
}>;
