import type { IrMemoryAccessKind } from "#ir/model/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { StateChannel } from "./slots.js";
import type { ValueId, ValueTable } from "./values.js";

export type RegionId = number;

// Static channels only for now; the dynamic (runtime-indexed) GPR slot
// variant joins this union when dynamic register access lands.
export type StateSlot = StateChannel;

// Maps one-to-one onto the wasm runtime's ExitReason; the action emitter
// owns the numeric encoding.
export type ActionExitReason =
  | "next"
  | "jump"
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
  access: IrMemoryAccessKind;
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

export type Action =
  | ReadStateAction
  | ReadMemoryAction
  | WriteStateAction
  | WriteMemoryAction
  | GuardMemoryAction
  | BranchAction
  | ExitAction;

export type ActionRegionKind = "entry" | "edge";

export type ActionRegion = Readonly<{
  id: RegionId;
  kind: ActionRegionKind;
  actions: readonly Action[];
}>;

export type ActionBlock = Readonly<{
  entry: RegionId;
  regions: readonly ActionRegion[];
  values: ValueTable;
}>;
