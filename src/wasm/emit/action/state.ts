import { assert } from "#common/assert.js";
import type { StateSlot } from "#ir/action/types.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmMemoryImmediate } from "#wasm/encoder/memory.js";
import { channelAccessByteLength, channelStateOffset } from "#wasm/state-layout.js";

// Channel loads and stores against state memory. The layout owns offsets and
// widths; this file only encodes the matching access.

export function emitChannelLoad(body: WasmFunctionBodyEncoder, slot: StateSlot): void {
  const immediate = channelImmediate(slot);

  body.i32Const(0);

  switch (channelAccessByteLength(slot)) {
    case 1:
      body.i32Load8U(immediate);
      return;
    case 2:
      body.i32Load16U(immediate);
      return;
    case 4:
      body.i32Load(immediate);
      return;
  }
}

export function emitChannelStore(
  body: WasmFunctionBodyEncoder,
  slot: StateSlot,
  emitValue: () => void
): void {
  const immediate = channelImmediate(slot);

  body.i32Const(0);
  emitValue();

  switch (channelAccessByteLength(slot)) {
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

function channelImmediate(slot: StateSlot): WasmMemoryImmediate {
  const offset = channelStateOffset(slot);

  return {
    align: channelAlign(offset, channelAccessByteLength(slot)),
    offset,
    memoryIndex: wasmMemoryIndex.state
  };
}

function channelAlign(offset: number, byteLength: 1 | 2 | 4): 0 | 1 | 2 {
  switch (byteLength) {
    case 1:
      return 0;
    case 2:
      return offset % 2 === 0 ? 1 : 0;
    case 4:
      assert(offset % 4 === 0, `4-byte state channel at unaligned offset ${offset}`);
      return 2;
  }
}
