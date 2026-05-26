import type { ExprRef } from "#x86/expr/types.js";
import type { IrMemoryAccessKind } from "#x86/ir/model/types.js";
import type { BlockState } from "./walk/state.js";
import type { OpSite } from "./walk/site.js";

export type BlockExitId = number & { readonly __blockExitId: unique symbol };

export type ExitKind =
  | "memoryFault"
  | "jump"
  | "branchTaken"
  | "branchNotTaken"
  | "hostTrap"
  | "fallthrough";

export type ExitPayload =
  | Readonly<{
      kind: "memoryFault";
      address: ExprRef;
      byteLength: number;
      access: IrMemoryAccessKind;
    }>
  | Readonly<{ kind: "jump"; target: ExprRef }>
  | Readonly<{ kind: "branch"; direction: "taken"; target: ExprRef }>
  | Readonly<{ kind: "branch"; direction: "notTaken" }>
  | Readonly<{ kind: "hostTrap"; vector: ExprRef }>
  | Readonly<{ kind: "fallthrough" }>;

export type BlockExit = Readonly<{
  id: BlockExitId;
  at: OpSite;
  kind: ExitKind;
  snapshot: BlockState;
  payload: ExitPayload;
}>;

export class BlockExitIds {
  #next = 0;

  next(): BlockExitId {
    const id = this.#next;

    this.#next += 1;
    return id as BlockExitId;
  }
}
