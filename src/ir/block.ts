import type { Action } from "./actions.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";

// `result` is the fallthrough value a body delivers when its owning control
// action declares an output; escaping bodies carry none.
export type Body = Readonly<{
  actions: readonly Action[];
  result?: ValueId;
}>;

export type IrBlock = Readonly<{
  body: Body;
  values: ValueTable;
}>;
