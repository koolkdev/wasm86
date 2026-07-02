import type { OperandWidth } from "#x86/types.js";
import type { X86StatusFlag } from "#x86/flags.js";
import {
  flagChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel
} from "./slots.js";
import type { StateSlot } from "./slots.js";
import {
  fitsUnsigned,
  signExtended,
  type ValueId,
  type ValueType,
  type WidthBounds
} from "./values.js";

export type StateReadOp = Readonly<{ kind: "state.read"; slot: StateSlot; signed?: true }>;
export type StateWriteOp = Readonly<{ kind: "state.write"; slot: StateSlot; value: ValueId }>;
export type MemoryReadOp = Readonly<{
  kind: "memory.read";
  address: ValueId;
  width: OperandWidth;
  signed?: true;
}>;
export type MemoryWriteOp = Readonly<{
  kind: "memory.write";
  address: ValueId;
  value: ValueId;
  width: OperandWidth;
}>;
export type CpuResolveFlagOp = Readonly<{ kind: "cpu.resolveFlag"; flag: X86StatusFlag }>;

export type IrOp = StateReadOp | StateWriteOp | MemoryReadOp | MemoryWriteOp | CpuResolveFlagOp;

export type StorageAccess =
  | Readonly<{ space: "state"; slot: StateSlot }>
  | Readonly<{ space: "memory" }>;

export type OpValueOutput = Readonly<{ type: ValueType; bounds?: WidthBounds }>;

export type OpAccess = Readonly<{
  valueInputs: readonly ValueId[];
  valueOutput?: OpValueOutput;
  reads: readonly StorageAccess[];
  writes: readonly StorageAccess[];
}>;

const memoryAccess: StorageAccess = { space: "memory" };

export function opAccess(op: IrOp): OpAccess {
  switch (op.kind) {
    case "state.read":
      return {
        valueInputs: slotValueInputs(op.slot),
        valueOutput: stateReadOutput(op.slot, op.signed === true),
        reads: [{ space: "state", slot: op.slot }],
        writes: []
      };
    case "state.write":
      return {
        valueInputs: [...slotValueInputs(op.slot), op.value],
        reads: [],
        writes: [{ space: "state", slot: op.slot }]
      };
    case "memory.read":
      return {
        valueInputs: [op.address],
        valueOutput: memoryReadOutput(op.width, op.signed === true),
        reads: [memoryAccess],
        writes: []
      };
    case "memory.write":
      return {
        valueInputs: [op.address, op.value],
        reads: [],
        writes: [memoryAccess]
      };
    case "cpu.resolveFlag":
      return {
        valueInputs: [],
        valueOutput: output(fitsUnsigned(1)),
        reads: [
          { space: "state", slot: flagChannel(op.flag) },
          { space: "state", slot: lazyFlagsKindChannel },
          { space: "state", slot: lazyFlagsAChannel },
          { space: "state", slot: lazyFlagsBChannel }
        ],
        writes: []
      };
  }
}

export function opValueInputs(op: IrOp): readonly ValueId[] {
  return opAccess(op).valueInputs;
}

export function opValueOutput(op: IrOp): OpValueOutput | undefined {
  return opAccess(op).valueOutput;
}

export function opReads(op: IrOp): readonly StorageAccess[] {
  return opAccess(op).reads;
}

export function opWrites(op: IrOp): readonly StorageAccess[] {
  return opAccess(op).writes;
}

export function opMutates(op: IrOp): boolean {
  return opWrites(op).length > 0;
}

function slotValueInputs(slot: StateSlot): readonly ValueId[] {
  switch (slot.kind) {
    case "gprDynamic":
    case "segmentDynamic":
      return [slot.index];
    case "gpr":
    case "flag":
    case "segment":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return [];
  }
}

function stateReadOutput(slot: StateSlot, signed: boolean): OpValueOutput {
  return output(readBounds(slot, signed));
}

function memoryReadOutput(width: OperandWidth, signed: boolean): OpValueOutput {
  if (width === 32) {
    return output();
  }

  return output(signed ? signExtended(width) : fitsUnsigned(width));
}

function readBounds(slot: StateSlot, signed: boolean): WidthBounds | undefined {
  switch (slot.kind) {
    case "gpr":
      return gprReadBounds(slot.byteLength, signed);
    case "gprDynamic":
      return gprReadBounds(slot.byteLength, signed);
    case "flag":
      return fitsUnsigned(1);
    case "segment":
      return slot.field === "selector" ? fitsUnsigned(16) : undefined;
    case "segmentDynamic":
      return slot.field === "selector" ? fitsUnsigned(16) : undefined;
    case "lazyFlags":
      return slot.field === "lazyFlagsKind" ? fitsUnsigned(8) : undefined;
    case "eip":
    case "instructionCount":
      return undefined;
  }
}

function gprReadBounds(byteLength: 1 | 2 | 4, signed: boolean): WidthBounds | undefined {
  switch (byteLength) {
    case 1:
      return signed ? signExtended(8) : fitsUnsigned(8);
    case 2:
      return signed ? signExtended(16) : fitsUnsigned(16);
    case 4:
      return undefined;
  }
}

function output(bounds?: WidthBounds): OpValueOutput {
  return bounds === undefined ? { type: "i32" } : { type: "i32", bounds };
}
