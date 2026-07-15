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
  DeclaredOperationInputs,
  OperationEmitTarget
} from "./definition.js";

// Mechanical state loads and stores. Static slots use layout immediates;
// dynamic slots add an index into the corresponding contiguous state array.

export function emitSlotLoad(
  target: OperationEmitTarget,
  slot: StateSlot,
  signed: boolean,
  inputs: DeclaredOperationInputs,
  accessByteLength?: 1 | 2
): void {
  const { body } = target;
  const access = accessByteLength ?? stateSlotAccessByteLength(slot);

  const immediate = slotImmediate(slot, access);

  emitSlotAddress(target, slot, declaredSlotIndex(slot, inputs));

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
  target: OperationEmitTarget,
  slot: StateSlot,
  inputs: DeclaredOperationInputs
): void {
  const valueInput = isDynamicSlot(slot) ? 1 : 0;

  emitSlotStoreWithUses(
    target.body,
    slot,
    declaredSlotIndex(slot, inputs),
    () => inputs.use(valueInput),
    target
  );
}

function emitSlotStoreWithUses(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  index: SlotIndexUse | undefined,
  emitValue: () => void,
  target?: OperationEmitTarget
): void {
  const immediate = slotImmediate(slot, stateSlotAccessByteLength(slot));

  if (target === undefined) {
    assert(!isDynamicSlot(slot), "dynamic slot lowering needs an operation target");
    body.i32Const(0);
  } else {
    emitSlotAddress(target, slot, index);
  }
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
}>;

function declaredSlotIndex(
  slot: StateSlot,
  inputs: DeclaredOperationInputs
): SlotIndexUse | undefined {
  if (!isDynamicSlot(slot)) {
    return undefined;
  }

  return {
    emitUse: () => inputs.use(0)
  };
}

function emitSlotAddress(
  target: OperationEmitTarget,
  slot: StateSlot,
  index: SlotIndexUse | undefined
): void {
  const { body } = target;

  switch (slot.kind) {
    case "gprDynamic":
      assert(index !== undefined, "dynamic slot lowering needs operand uses");
      emitDynamicGprOffset(target, slot, index);
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
  target: OperationEmitTarget,
  slot: GprDynamicSlot,
  index: SlotIndexUse
): void {
  const { body } = target;

  // Word access is (index & 7) * 4. Byte registers use word index & 3,
  // plus one byte for high-register encodings 4..7.
  switch (slot.byteLength) {
    case 4:
    case 2:
      index.emitUse();
      body.i32Const(7).i32And().i32Const(2).i32Shl();
      return;
    case 1:
      target.withTemporaryLocal("i32", (indexLocal) => {
        index.emitUse();
        body.localTee(indexLocal);
        body.i32Const(3).i32And().i32Const(2).i32Shl();
        body.localGet(indexLocal);
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
