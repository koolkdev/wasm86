import { wasmGuestMemoryMinByteLength, wasmGuestMemoryMinPages, wasmPageByteLength } from "#wasm/abi.js";
import { executionStateLayout } from "#ir/state-layout.js";
import { WasmCpuState } from "./cpu-state.js";

export type WasmHostMemories = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  cpuState: WasmCpuState;
}>;

export type WasmHostMemoryOptions = Readonly<{
  guestMemoryByteLength?: number;
  cpuStateMemory?: WebAssembly.Memory;
  guestMemory?: WebAssembly.Memory;
}>;

export function createWasmHostMemories(options: WasmHostMemoryOptions = {}): WasmHostMemories {
  const cpuStateMemory = options.cpuStateMemory ?? new WebAssembly.Memory({
    initial: wasmPagesForByteLength(executionStateLayout.byteLength)
  });
  const guestMemory = options.guestMemory ?? new WebAssembly.Memory({
    initial: wasmPagesForByteLength(options.guestMemoryByteLength ?? wasmGuestMemoryMinByteLength)
  });

  return {
    cpuStateMemory,
    guestMemory,
    cpuState: new WasmCpuState(cpuStateMemory)
  };
}

export function wasmPagesForByteLength(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`byteLength must be a non-negative integer: ${byteLength}`);
  }

  return Math.max(wasmGuestMemoryMinPages, Math.ceil(byteLength / wasmPageByteLength));
}
