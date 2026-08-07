import type { Operation } from "#compiler/function/operation.js";
import type { ValueRef } from "#compiler/function/values.js";
import type { Control } from "#compiler/function/control.js";
import type { VariableRef } from "#compiler/function/storage.js";

export type RegionNode = Operation | Control;

// `result` is the fallthrough value a body delivers when its owning control
// declares an output; escaping bodies carry none. `writes` (nested bodies
// included) and `completes` are builder facts, snapshot per build() call.
export type Region = Readonly<{
  nodes: readonly RegionNode[];
  result?: ValueRef;
  writes: ReadonlySet<VariableRef>;
  completes: boolean;
}>;
