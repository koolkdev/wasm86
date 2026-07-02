import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { RegionId } from "./block.js";
import type { IrOp, StateWriteOp } from "./ops.js";
import type { ValueId } from "./values.js";

// Reports to the host; the action emitter owns the numeric encoding.
export type ActionExitReason =
  | "hostTrap"
  | "unsupported"
  | "decodeFault"
  | "memoryReadFault"
  | "memoryWriteFault";

export type OpAction = Readonly<{ kind: "op"; op: IrOp; output?: ValueId }>;

export type GuardMemoryAction = Readonly<{
  kind: "guardMemory";
  address: ValueId;
  byteLength: number;
  access: MemoryAccessKind;
  faultEdge: RegionId;
}>;

export type BranchAction = Readonly<{
  kind: "branch";
  condition: ValueId;
  taken: RegionId;
  notTaken: RegionId;
}>;

export type ExitAction = Readonly<{
  kind: "exit";
  reason: ActionExitReason;
  payload?: ValueId;
}>;

// The block completed guest execution and asks the embedding to dispatch to
// this already-committed target EIP.
export type DispatchAction = Readonly<{
  kind: "dispatch";
  targetEip: ValueId;
}>;

export type Action =
  | OpAction
  | GuardMemoryAction
  | BranchAction
  | ExitAction
  | DispatchAction;

export type EdgeFlushAction = Readonly<{ kind: "op"; op: StateWriteOp }>;

export type TerminatorAction = BranchAction | ExitAction | DispatchAction;

export function isTerminatorAction(action: Action): action is TerminatorAction {
  switch (action.kind) {
    case "branch":
    case "exit":
    case "dispatch":
      return true;
    case "op":
    case "guardMemory":
      return false;
  }
}
