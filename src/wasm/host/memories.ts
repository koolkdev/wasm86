import { wasmGuestMemoryMinByteLength, wasmGuestMemoryMinPages, wasmPageByteLength } from "#wasm/abi.js";
import { WasmCpuState } from "./state-memory.js";
import { WasmGuestMemory } from "./guest-memory.js";

export type WasmHostMemories = Readonly<{
  stateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  state: WasmCpuState;
  guest: WasmGuestMemory;
}>;

export type WasmHostMemoryOptions = Readonly<{
  guestMemoryByteLength?: number;
  stateMemory?: WebAssembly.Memory;
  guestMemory?: WebAssembly.Memory;
}>;

export function createWasmHostMemories(options: WasmHostMemoryOptions = {}): WasmHostMemories {
  const stateMemory = options.stateMemory ?? new WebAssembly.Memory({ initial: 1 });
  const guestMemory = options.guestMemory ?? new WebAssembly.Memory({
    initial: wasmPagesForByteLength(options.guestMemoryByteLength ?? wasmGuestMemoryMinByteLength)
  });

  return {
    stateMemory,
    guestMemory,
    state: new WasmCpuState(stateMemory),
    guest: new WasmGuestMemory(guestMemory)
  };
}

export function wasmPagesForByteLength(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`byteLength must be a non-negative integer: ${byteLength}`);
  }

  return Math.max(wasmGuestMemoryMinPages, Math.ceil(byteLength / wasmPageByteLength));
}
