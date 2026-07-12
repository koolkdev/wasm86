import { ok } from "node:assert";

import { decodeIsaBlock } from "#core/decoder/decode-block.js";
import {
  truncatedInstructionFault,
  IsaDecodeError,
  type IsaDecodeReader
} from "#core/decoder/reader.js";
import { compileActionWasmBlockHandle } from "#engines/jit/block-handle.js";
import { readBackingByte, writeBackingBytes } from "#memory/bytes.js";
import { startAddress } from "#test/support/addresses.js";
import {
  readWasmCpuState,
  type WasmCpuStateInit,
  type WasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import type { DecodedExit } from "#wasm/exit.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";

export type CompiledInstructionMemoryPatch = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

export type CompiledInstructionMemoryRange = Readonly<{
  address: number;
  byteLength: number;
}>;

export type CompiledInstructionMemorySnapshot = CompiledInstructionMemoryRange & Readonly<{
  bytes: readonly number[];
}>;

export type RunCompiledInstructionsInput = Readonly<{
  bytes: readonly number[];
  initialState?: WasmCpuStateInit;
  memoryPatches?: readonly CompiledInstructionMemoryPatch[];
  memoryRanges?: readonly CompiledInstructionMemoryRange[];
}>;

export type CompiledInstructionResult = Readonly<{
  completion: DecodedExit;
  state: WasmCpuStateSnapshot;
  memory: readonly CompiledInstructionMemorySnapshot[];
}>;

export async function runCompiledInstructions(
  input: RunCompiledInstructionsInput
): Promise<CompiledInstructionResult> {
  const instructionAddress = input.initialState?.eip ?? startAddress;
  const block = decodeIsaBlock(
    new FiniteInstructionReader(input.bytes, instructionAddress),
    instructionAddress
  );
  const memories = createWasmHostMemories();

  for (const patch of input.memoryPatches ?? []) {
    const faultAddress = writeBackingBytes(memories.guestMemory, patch.address, patch.bytes);

    ok(
      faultAddress === undefined,
      `compiled instruction memory patch is out of bounds at 0x${faultAddress?.toString(16)}`
    );
  }

  memories.cpuState.load({ ...input.initialState, eip: instructionAddress });

  const handle = compileActionWasmBlockHandle([block], {
    cpuStateMemory: memories.cpuStateMemory,
    guestMemory: memories.guestMemory
  });
  const completion = handle.run(instructionAddress).exit;

  return {
    completion,
    state: readWasmCpuState(memories.cpuState),
    memory: (input.memoryRanges ?? []).map((range) => ({
      ...range,
      bytes: readMemoryRange(memories.guestMemory, range)
    }))
  };
}

class FiniteInstructionReader implements IsaDecodeReader {
  readonly #bytes: Uint8Array<ArrayBuffer>;

  constructor(bytes: readonly number[], readonly baseAddress: number) {
    this.#bytes = Uint8Array.from(bytes);
  }

  readU8(address: number): number {
    const index = address - this.baseAddress;
    const value = this.#bytes[index];

    if (!Number.isInteger(index) || index < 0 || value === undefined) {
      throw new IsaDecodeError(truncatedInstructionFault(address));
    }

    return value;
  }
}

function readMemoryRange(
  memory: WebAssembly.Memory,
  range: CompiledInstructionMemoryRange
): readonly number[] {
  ok(
    Number.isInteger(range.byteLength) && range.byteLength >= 0,
    `compiled instruction memory range has invalid byte length: ${range.byteLength}`
  );

  const bytes: number[] = [];

  for (let index = 0; index < range.byteLength; index += 1) {
    const address = range.address + index;
    const value = readBackingByte(memory, address);

    ok(value !== undefined, `compiled instruction memory range is out of bounds at 0x${address.toString(16)}`);
    bytes.push(value);
  }

  return bytes;
}
