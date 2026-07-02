import type { Action } from "./actions.js";
import type { ValueTable } from "./values.js";

export type Body = Readonly<{
  actions: readonly Action[];
}>;

export type IrBlock = Readonly<{
  body: Body;
  values: ValueTable;
}>;
