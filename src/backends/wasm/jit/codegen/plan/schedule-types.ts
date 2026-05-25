import type {
  JitLoadResultValue,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import type { IrMemoryAccessKind } from "#x86/ir/model/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { Exit } from "#backends/wasm/jit/analysis/exits.js";

export type Placement = Readonly<{
  opIndex: number;
  epoch: number;
}>;

type ScheduleEntryBase<TKind extends string> = Readonly<{
  kind: TKind;
  at: Placement;
}>;

export type MemoryGuardEntry = ScheduleEntryBase<"memoryGuard"> & Readonly<{
  address: JitValue;
  byteLength: number;
  access: IrMemoryAccessKind;
  exit: Exit;
}>;

export type MemoryStoreEntry = ScheduleEntryBase<"memoryStore"> & Readonly<{
  address: JitValue;
  value: JitValue;
  width: OperandWidth;
}>;

export type JumpEntry = ScheduleEntryBase<"jump"> & Readonly<{
  target: JitValue;
  exit: Exit;
}>;

export type BranchEntry = ScheduleEntryBase<"branch"> & Readonly<{
  condition: JitValue;
  takenTarget: JitValue;
  notTakenTarget: JitValue;
  taken: Exit;
  notTaken: Exit;
}>;

export type ControlEntry =
  | JumpEntry
  | BranchEntry;

export type HostTrapEntry = ScheduleEntryBase<"hostTrap"> & Readonly<{
  vector: JitValue;
  exit: Exit;
}>;

export type FallthroughEntry = ScheduleEntryBase<"fallthrough"> & Readonly<{
  exit: Exit;
}>;

export type RuntimeEntry =
  | MemoryGuardEntry
  | MemoryStoreEntry
  | ControlEntry
  | HostTrapEntry
  | FallthroughEntry;

export type MemoryLoadValueEntry = ScheduleEntryBase<"defineLoadResult"> & Readonly<{
  result: JitLoadResultValue;
  address: JitValue;
  width: OperandWidth;
}>;

export type DefinitionEntry =
  | MemoryLoadValueEntry;

export type BlockScheduleEntry =
  | RuntimeEntry
  | DefinitionEntry;

export type BlockSchedule = readonly BlockScheduleEntry[];
