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

export type Finish =
  | Readonly<{
      kind: "dispatch";
      targetEip: ValueId;
    }>
  | Readonly<{
      kind: "exit";
      reason: ActionExitReason;
      payload?: ValueId;
    }>;

export type FinishAction = Readonly<{
  kind: "finish";
  finish: Finish;
}>;

export type ExitFinish = Extract<Finish, { kind: "exit" }>;

export type DispatchFinish = Extract<Finish, { kind: "dispatch" }>;

export type Action =
  | OpAction
  | GuardMemoryAction
  | BranchAction
  | FinishAction;

export type EdgeFlushAction = Readonly<{ kind: "op"; op: StateWriteOp }>;

export type TerminatorAction = BranchAction | FinishAction;

export function isTerminatorAction(action: Action): action is TerminatorAction {
  switch (action.kind) {
    case "branch":
    case "finish":
      return true;
    case "op":
    case "guardMemory":
      return false;
  }
}
