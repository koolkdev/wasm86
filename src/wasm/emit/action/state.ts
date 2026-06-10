import { assert } from "#common/assert.js";
import type { GprDynamicSlot, StateSlot } from "#ir/action/types.js";
import type { ValueId } from "#ir/action/values.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import { channelAccessByteLength, channelStateOffset, WASM_GPR_BASE_OFFSET } from "#wasm/state-layout.js";

// State slot loads and stores. The layout owns offsets and widths; this file
// only encodes the matching access. A dynamic slot lowers to address math
// over the GPR words — the index is masked to 0..7, so a stray index stays
// inside the register file.

export function emitSlotLoad(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  signed: boolean,
  emitUse: (id: ValueId) => void
): void {
  const immediate = slotImmediate(slot);

  emitSlotAddress(body, slot, emitUse);

  switch (slotAccessByteLength(slot)) {
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
  emitUse: (id: ValueId) => void
): void {
  const immediate = slotImmediate(slot);

  emitSlotAddress(body, slot, emitUse);
  emitUse(value);

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

function emitSlotAddress(body: WasmFunctionBodyEncoder, slot: StateSlot, emitUse: (id: ValueId) => void): void {
  switch (slot.kind) {
    case "gprDynamic":
      emitDynamicGprOffset(body, slot, emitUse);
      return;
    case "gpr":
    case "flag":
    case "eip":
      body.i32Const(0);
      return;
  }
}

// Word access: (index & 7) * 4. Byte access follows the byte-register
// encoding — word index & 3, plus one for the high byte (indices 4..7):
// (index & 3) * 4 + (index >> 2 & 1).
function emitDynamicGprOffset(
  body: WasmFunctionBodyEncoder,
  slot: GprDynamicSlot,
  emitUse: (id: ValueId) => void
): void {
  switch (slot.byteLength) {
    case 4:
    case 2:
      emitUse(slot.index);
      body.i32Const(7).i32And().i32Const(2).i32Shl();
      return;
    case 1:
      emitUse(slot.index);
      body.i32Const(3).i32And().i32Const(2).i32Shl();
      emitUse(slot.index);
      body.i32Const(2).i32ShrU().i32Const(1).i32And();
      body.i32Add();
      return;
  }
}

function slotImmediate(slot: StateSlot): WasmMemoryImmediate {
  const offset = slotBaseOffset(slot);

  return {
    align: accessAlign(offset, slotAccessByteLength(slot)),
    offset,
    memoryIndex: wasmMemoryIndex.state
  };
}

function slotBaseOffset(slot: StateSlot): number {
  switch (slot.kind) {
    case "gprDynamic":
      return WASM_GPR_BASE_OFFSET;
    case "gpr":
    case "flag":
    case "eip":
      return channelStateOffset(slot);
  }
}

function slotAccessByteLength(slot: StateSlot): 1 | 2 | 4 {
  switch (slot.kind) {
    case "gprDynamic":
      return slot.byteLength;
    case "gpr":
    case "flag":
    case "eip":
      return channelAccessByteLength(slot);
  }
}

// Dynamic addresses are the base plus a multiple of 4, so the base offset's
// alignment carries to every indexed address.
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
