import { wasmGuestMemoryMinByteLength, wasmGuestMemoryMinPages, wasmPageByteLength } from "#wasm/abi.js";
import { MACHINE_FIXED_END } from "#wasm/machine-state-layout.js";
import { WasmCpuState } from "./cpu-state.js";
import { WasmGuestMemory } from "./guest-memory.js";
import { MachineState } from "./machine-state.js";

export type WasmHostMemories = Readonly<{
  cpuStateMemory: WebAssembly.Memory;
  guestMemory: WebAssembly.Memory;
  machineMemory: WebAssembly.Memory;
  cpuState: WasmCpuState;
  guest: WasmGuestMemory;
  machine: MachineState;
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
    initial: wasmPagesForByteLength(MACHINE_FIXED_END)
  });

  return {
    cpuStateMemory,
    guestMemory,
    machineMemory,
    cpuState: new WasmCpuState(cpuStateMemory),
    guest: new WasmGuestMemory(guestMemory),
    machine: new MachineState(machineMemory)
  };
}

export function wasmPagesForByteLength(byteLength: number): number {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new RangeError(`byteLength must be a non-negative integer: ${byteLength}`);
  }

  return Math.max(wasmGuestMemoryMinPages, Math.ceil(byteLength / wasmPageByteLength));
}
