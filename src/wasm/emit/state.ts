import { assert } from "#common/assert.js";
import type { GprDynamicSlot, SegmentDynamicSlot, StateChannel, StateSlot } from "#ir/slots.js";
import type { ValueId } from "#ir/values.js";
import type { OperandUses } from "./ops.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import {
  wasmCpuStateChannelAccessByteLength,
  wasmCpuStateChannelOffset,
  WASM_CPU_GPR_BASE_OFFSET,
  WASM_CPU_SEGMENT_ACCESS_OFFSET,
  WASM_CPU_SEGMENT_BASE_OFFSET,
  WASM_CPU_SEGMENT_LIMIT_OFFSET,
  WASM_CPU_SEGMENT_SELECTOR_OFFSET
} from "#wasm/cpu-state-layout.js";

// State slot loads and stores. The layout owns offsets and widths; this file
// only encodes the matching access. A dynamic slot lowers to address math
// over contiguous state arrays. Dynamic GPR indexes come from ModRM fields and
// are masked to the register file. Dynamic segment indexes are produced by
// prefix decode in segmentRegisters order.

// A channel's offset is static: nothing to consume.
export function emitSlotLoad(body: WasmFunctionBodyEncoder, channel: StateChannel, signed: boolean): void;
export function emitSlotLoad(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  signed: boolean,
  operands: OperandUses,
  accessByteLength?: 1 | 2
): void;
export function emitSlotLoad(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  signed: boolean,
  operands?: OperandUses,
  accessByteLength?: 1 | 2
): void {
  const access = accessByteLength ?? slotAccessByteLength(slot);

  assert(
    accessByteLength === undefined || accessByteLength < slotAccessByteLength(slot),
    "a narrowed slot access must be narrower than the slot"
  );

  const immediate = slotImmediate(slot, access);

  emitSlotAddress(body, slot, operands);

  switch (access) {
    case 1:
      signed ? body.i32Load8S(immediate) : body.i32Load8U(immediate);
      return;
    case 2:
      signed ? body.i32Load16S(immediate) : body.i32Load16U(immediate);
      return;
    case 4:
      // Sign extension from the full width is the identity.
      body.i32Load(immediate);
      return;
  }
}

export function emitSlotStore(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  value: ValueId,
  operands: OperandUses
): void {
  const immediate = slotImmediate(slot, slotAccessByteLength(slot));

  emitSlotAddress(body, slot, operands);
  operands.emitUse(value);

  switch (slotAccessByteLength(slot)) {
    case 1:
      body.i32Store8(immediate);
      return;
    case 2:
      body.i32Store16(immediate);
      return;
    case 4:
      body.i32Store(immediate);
      return;
  }
}

// Each slot operand is consumed exactly once; repeated observation goes
// through a borrow.
function emitSlotAddress(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  operands: OperandUses | undefined
): void {
  switch (slot.kind) {
    case "gprDynamic":
      assert(operands, "dynamic slot lowering needs operand uses");
      emitDynamicGprOffset(body, slot, operands);
      return;
    case "segmentDynamic":
      assert(operands, "dynamic slot lowering needs operand uses");
      emitDynamicSegmentOffset(body, slot, operands);
      return;
    case "gpr":
    case "flag":
    case "segment":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      body.i32Const(0);
      return;
  }
}

// Word access: (index & 7) * 4. Byte access follows the byte-register
// encoding — word index & 3, plus one for the high byte (indices 4..7):
// (index & 3) * 4 + (index >> 2 & 1). The byte case reads the index twice,
// so it borrows it.
function emitDynamicGprOffset(
  body: WasmFunctionBodyEncoder,
  slot: GprDynamicSlot,
  operands: OperandUses
): void {
  switch (slot.byteLength) {
    case 4:
    case 2:
      operands.emitUse(slot.index);
      body.i32Const(7).i32And().i32Const(2).i32Shl();
      return;
    case 1:
      operands.withBorrowedUse(slot.index, (index) => {
        index.push();
        body.i32Const(3).i32And().i32Const(2).i32Shl();
        index.push();
        body.i32Const(2).i32ShrU().i32Const(1).i32And();
        body.i32Add();
      });
      return;
  }
}

function emitDynamicSegmentOffset(
  body: WasmFunctionBodyEncoder,
  slot: SegmentDynamicSlot,
  operands: OperandUses
): void {
  operands.emitUse(slot.index);
  body.i32Const(slot.field === "selector" ? 1 : 2).i32Shl();
}

function slotImmediate(slot: StateSlot, accessByteLength: 1 | 2 | 4): WasmMemoryImmediate {
  const offset = slotBaseOffset(slot);

  return {
    align: accessAlign(offset, accessByteLength),
    offset,
    memoryIndex: wasmMemoryIndex.cpuState
  };
}

function slotBaseOffset(slot: StateSlot): number {
  switch (slot.kind) {
    case "gprDynamic":
      return WASM_CPU_GPR_BASE_OFFSET;
    case "segmentDynamic":
      switch (slot.field) {
        case "selector":
          return WASM_CPU_SEGMENT_SELECTOR_OFFSET;
        case "base":
          return WASM_CPU_SEGMENT_BASE_OFFSET;
        case "limit":
          return WASM_CPU_SEGMENT_LIMIT_OFFSET;
        case "access":
          return WASM_CPU_SEGMENT_ACCESS_OFFSET;
      }
    case "gpr":
    case "flag":
    case "segment":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return wasmCpuStateChannelOffset(slot);
  }
}

function slotAccessByteLength(slot: StateSlot): 1 | 2 | 4 {
  switch (slot.kind) {
    case "gprDynamic":
      return slot.byteLength;
    case "segmentDynamic":
      return slot.field === "selector" ? 2 : 4;
    case "gpr":
    case "flag":
    case "segment":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return wasmCpuStateChannelAccessByteLength(slot);
  }
}

// Dynamic state addresses add an aligned segment-field array offset, so the
// selected field's alignment carries to every indexed address.
function accessAlign(offset: number, byteLength: 1 | 2 | 4): 0 | 1 | 2 {
  switch (byteLength) {
    case 1:
      return 0;
    case 2:
      return offset % 2 === 0 ? 1 : 0;
    case 4:
      assert(offset % 4 === 0, `4-byte state access at unaligned offset ${offset}`);
      return 2;
  }
}
