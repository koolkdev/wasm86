import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { OperandWidth } from "#x86/types.js";
import type { RegionId } from "./block.js";
import type { StateChannel } from "./slots.js";
import type { ValueId } from "./values.js";

// The index is the x86 register number for the access width (modrm encoding).
export type GprDynamicSlot = Readonly<{
  kind: "gprDynamic";
  index: ValueId;
  byteLength: 1 | 2 | 4;
}>;

export type StateSlot = StateChannel | GprDynamicSlot;

// Reports to the host; the action emitter owns the numeric encoding.
export type ActionExitReason =
  | "hostTrap"
  | "unsupported"
  | "decodeFault"
  | "memoryReadFault"
  | "memoryWriteFault";

export type ReadStateAction = Readonly<{
  kind: "readState";
  output: ValueId;
  slot: StateSlot;
  // Present only on channels narrower than the word: the emitter lowers the
  // read to a sign-extending load.
  signed?: true;
}>;

export type ReadMemoryAction = Readonly<{
  kind: "readMemory";
  output: ValueId;
  address: ValueId;
  width: OperandWidth;
  // Present only below the word width: the emitter lowers the read to a
  // sign-extending load.
  signed?: true;
}>;

export type WriteStateAction = Readonly<{
  kind: "writeState";
  slot: StateSlot;
  value: ValueId;
}>;

export type WriteMemoryAction = Readonly<{
  kind: "writeMemory";
  address: ValueId;
  value: ValueId;
  width: OperandWidth;
}>;

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
  | ReadStateAction
  | ReadMemoryAction
  | WriteStateAction
  | WriteMemoryAction
  | GuardMemoryAction
  | BranchAction
  | ExitAction
  | DispatchAction;

export type EdgeFlushAction = WriteStateAction;

export type TerminatorAction = BranchAction | ExitAction | DispatchAction;

export function isTerminatorAction(action: Action): action is TerminatorAction {
  switch (action.kind) {
    case "branch":
    case "exit":
    case "dispatch":
      return true;
    case "readState":
    case "readMemory":
    case "writeState":
    case "writeMemory":
    case "guardMemory":
      return false;
  }
}
