import { createCpu, type Cpu } from "#cpu/cpu.js";
import { wasmPageByteLength } from "#wasm/abi.js";

export type MachineOptions = Readonly<{
  memoryByteLength: number;
}>;

export type Machine = Readonly<{
  memory: WebAssembly.Memory;
  cpu: Cpu;
}>;

const x86PageByteLength = 0x1000;
const x86AddressSpaceByteLength = 0x1_0000_0000;

export function createMachine(options: MachineOptions): Machine {
  const { memoryByteLength } = options;

  if (
    !Number.isSafeInteger(memoryByteLength) ||
    memoryByteLength <= 0 ||
    memoryByteLength > x86AddressSpaceByteLength ||
    memoryByteLength % x86PageByteLength !== 0
  ) {
    throw new RangeError(
      `memoryByteLength must be a positive 4 KiB-aligned integer no greater than 4 GiB: ` +
      memoryByteLength
    );
  }

  const memory = new WebAssembly.Memory({
    initial: Math.ceil(memoryByteLength / wasmPageByteLength)
  });
  const cpu = createCpu(memory);

  return {
    memory,
    cpu
  };
}
