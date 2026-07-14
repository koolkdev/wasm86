import { descriptorTableByteLength } from "#memory/descriptors/layout.js";
import { DescriptorTableView } from "#memory/descriptors/view.js";
import { wasmGuestMemoryMinByteLength, wasmGuestMemoryMinPages, wasmPageByteLength } from "#wasm/abi.js";
import { WasmCpuState } from "./cpu-state.js";

export type WasmHostMemories = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  machineMemory: WebAssembly.Memory;
  cpuState: WasmCpuState;
  machine: DescriptorTableView;
}>;

export type WasmHostMemoryOptions = Readonly<{
  guestMemoryByteLength?: number;
  cpuStateMemory?: WebAssembly.Memory;
  guestMemory?: WebAssembly.Memory;
  machineMemory?: WebAssembly.Memory;
}>;

export function createWasmHostMemories(options: WasmHostMemoryOptions = {}): WasmHostMemories {
  const cpuStateMemory = options.cpuStateMemory ?? new WebAssembly.Memory({ initial: 1 });
  const guestMemory = options.guestMemory ?? new WebAssembly.Memory({
    initial: wasmPagesForByteLength(options.guestMemoryByteLength ?? wasmGuestMemoryMinByteLength)
  });
  const machineMemory = options.machineMemory ?? new WebAssembly.Memory({
    initial: wasmPagesForByteLength(descriptorTableByteLength)
  });

  return {
    cpuStateMemory,
    guestMemory,
    machineMemory,
    cpuState: new WasmCpuState(cpuStateMemory),
    machine: new DescriptorTableView(machineMemory)
  };
}

export function wasmPagesForByteLength(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`byteLength must be a non-negative integer: ${byteLength}`);
  }

  return Math.max(wasmGuestMemoryMinPages, Math.ceil(byteLength / wasmPageByteLength));
}
