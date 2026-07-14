import { assert } from "#common/assert.js";
import type { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#compiler/encoder/memory.js";
import {
  isDynamicSlot,
  type GprDynamicSlot,
  type SegmentDynamicSlot,
  type StateChannel,
  type StateSlot
} from "#ir/slots.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import {
  wasmCpuStateChannelAccessByteLength,
  wasmCpuStateChannelOffset,
  WASM_CPU_GPR_BASE_OFFSET,
  WASM_CPU_SEGMENT_ACCESS_OFFSET,
  WASM_CPU_SEGMENT_BASE_OFFSET,
  WASM_CPU_SEGMENT_LIMIT_OFFSET,
  WASM_CPU_SEGMENT_SELECTOR_OFFSET
} from "#wasm/cpu-state-layout.js";
import type {
  BorrowedOperationInput,
  DeclaredOperationInputs
} from "./definition.js";

// Mechanical state loads and stores. Static slots use layout immediates;
// dynamic slots add an index into the corresponding contiguous state array.

export function emitSlotLoad(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  signed: boolean,
  inputs: DeclaredOperationInputs,
  accessByteLength?: 1 | 2
): void {
  const access = accessByteLength ?? stateSlotAccessByteLength(slot);

  const immediate = slotImmediate(slot, access);

  emitSlotAddress(body, slot, declaredSlotIndex(slot, inputs));

  switch (access) {
    case 1:
      signed ? body.i32Load8S(immediate) : body.i32Load8U(immediate);
      return;
    case 2:
      signed ? body.i32Load16S(immediate) : body.i32Load16U(immediate);
      return;
    case 4:
      body.i32Load(immediate);
      return;
  }
}

export function emitChannelStore(
  body: WasmFunctionBodyEncoder,
  channel: StateChannel,
  emitValue: () => void
): void {
  emitSlotStoreWithUses(body, channel, undefined, emitValue);
}

export function emitOperationSlotStore(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  inputs: DeclaredOperationInputs
): void {
  const valueInput = isDynamicSlot(slot) ? 1 : 0;

  emitSlotStoreWithUses(
    body,
    slot,
    declaredSlotIndex(slot, inputs),
    () => inputs.use(valueInput)
  );
}

function emitSlotStoreWithUses(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  index: SlotIndexUse | undefined,
  emitValue: () => void
): void {
  const immediate = slotImmediate(slot, stateSlotAccessByteLength(slot));

  emitSlotAddress(body, slot, index);
  emitValue();

  switch (stateSlotAccessByteLength(slot)) {
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

type SlotIndexUse = Readonly<{
  emitUse(): void;
  withBorrowedUse(callback: (borrowed: BorrowedOperationInput) => void): void;
}>;

function declaredSlotIndex(
  slot: StateSlot,
  inputs: DeclaredOperationInputs
): SlotIndexUse | undefined {
  if (!isDynamicSlot(slot)) {
    return undefined;
  }

  return {
    emitUse: () => inputs.use(0),
    withBorrowedUse: (callback) => inputs.withBorrowedUse(0, callback)
  };
}

function emitSlotAddress(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  index: SlotIndexUse | undefined
): void {
  switch (slot.kind) {
    case "gprDynamic":
      assert(index !== undefined, "dynamic slot lowering needs operand uses");
      emitDynamicGprOffset(body, slot, index);
      return;
    case "segmentDynamic":
      assert(index !== undefined, "dynamic slot lowering needs operand uses");
      emitDynamicSegmentOffset(body, slot, index);
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

function emitDynamicGprOffset(
  body: WasmFunctionBodyEncoder,
  slot: GprDynamicSlot,
  index: SlotIndexUse
): void {
  // Word access is (index & 7) * 4. Byte registers use word index & 3,
  // plus one byte for high-register encodings 4..7.
  switch (slot.byteLength) {
    case 4:
    case 2:
      index.emitUse();
      body.i32Const(7).i32And().i32Const(2).i32Shl();
      return;
    case 1:
      index.withBorrowedUse((borrowed) => {
        borrowed.push();
        body.i32Const(3).i32And().i32Const(2).i32Shl();
        borrowed.push();
        body.i32Const(2).i32ShrU().i32Const(1).i32And();
        body.i32Add();
      });
      return;
  }
}

function emitDynamicSegmentOffset(
  body: WasmFunctionBodyEncoder,
  slot: SegmentDynamicSlot,
  index: SlotIndexUse
): void {
  index.emitUse();
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

export function stateSlotAccessByteLength(slot: StateSlot): 1 | 2 | 4 {
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
