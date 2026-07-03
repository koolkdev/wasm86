import type { Action } from "./actions.js";
import type { ValueId, ValueTable } from "./values.js";

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
