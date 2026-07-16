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
import {
  executionStateLayout,
  stateSlotLocation,
  type StateLocation
} from "#ir/state-layout.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
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
  const strideShift = powerOfTwoShift(dynamicArrayStride(slot));

  // Word access is (index & 7) * stride. Byte registers use word index & 3,
  // plus one byte for high-register encodings 4..7.
  switch (slot.byteLength) {
    case 4:
    case 2:
      index.emitUse();
      body.i32Const(7).i32And().i32Const(strideShift).i32Shl();
      return;
    case 1:
      target.withTemporaryLocal("i32", (indexLocal) => {
        index.emitUse();
        body.localTee(indexLocal);
        body.i32Const(3).i32And().i32Const(strideShift).i32Shl();
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
  body.i32Const(powerOfTwoShift(dynamicArrayStride(slot))).i32Shl();
}

function slotImmediate(slot: StateSlot, accessByteLength: 1 | 2 | 4): WasmMemoryImmediate {
  const offset = locationOffset(stateSlotLocation(slot));

  return {
    align: accessAlign(offset, accessByteLength),
    offset,
    memoryIndex: wasmMemoryIndex.cpuState
  };
}

function locationOffset(location: StateLocation): number {
  switch (location.kind) {
    case "field":
      return executionStateLayout.field(location.field).offset;
    case "element": {
      const array = executionStateLayout.array(location.array);

      return array.offset + location.index * array.stride + location.byteOffset;
    }
    case "array":
      return executionStateLayout.array(location.array).offset;
  }
}

export function stateSlotAccessByteLength(slot: StateSlot): 1 | 2 | 4 {
  const location = stateSlotLocation(slot);

  switch (location.kind) {
    case "field":
      return executionStateLayout.field(location.field).byteLength;
    case "element":
      return location.byteLength;
    case "array":
      if (slot.kind === "gprDynamic") {
        return slot.byteLength;
      }

      assert(slot.kind === "segmentDynamic", "array location belongs to a static state slot");
      return executionStateLayout.array(location.array).elementByteLength;
  }
}

function dynamicArrayStride(slot: GprDynamicSlot | SegmentDynamicSlot): number {
  const location = stateSlotLocation(slot);

  assert(location.kind === "array", "dynamic state slot must resolve to an array");
  return executionStateLayout.array(location.array).stride;
}

function powerOfTwoShift(stride: number): number {
  assert(
    Number.isInteger(stride) && stride > 0 && (stride & (stride - 1)) === 0,
    `dynamic state array stride must be a positive power of two, got ${stride}`
  );
  return Math.log2(stride);
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
