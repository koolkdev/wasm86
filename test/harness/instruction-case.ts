import { deepStrictEqual } from "node:assert";

import {
  runCompiledInstructions,
  type CompiledInstructionCompletion,
  type CompiledInstructionMemoryPatch,
  type CompiledInstructionResult
} from "./compiled-instruction.js";
import { startAddress } from "#test/support/addresses.js";
import {
  createWasmCpuArchitecturalStateSnapshot,
  type WasmCpuArchitecturalStateInit
} from "#test/support/cpu-state.js";

type InstructionState = Omit<
  WasmCpuArchitecturalStateInit,
  "eip" | "instructionCount"
>;

export type InstructionMemoryImage = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

export type InstructionCase = Readonly<{
  name: string;
  bytes: readonly number[];
  initialState?: InstructionState;
  expectedState?: InstructionState;
  expectedCompletion?: CompiledInstructionCompletion;
  expectedEip?: number;
  instructionCount?: number;
  memoryPatches?: readonly CompiledInstructionMemoryPatch[];
  expectedMemory?: readonly InstructionMemoryImage[];
}>;

export async function assertInstructionCase(
  entry: InstructionCase
): Promise<CompiledInstructionResult> {
  const expectedEip = entry.expectedEip ?? startAddress + entry.bytes.length;
  const instructionCount = entry.instructionCount ?? 1;
  const initialState = createWasmCpuArchitecturalStateSnapshot({
    eip: startAddress,
    instructionCount: 7,
    ...entry.initialState
  });
  const result = await runCompiledInstructions({
    bytes: entry.bytes,
    initialState,
    ...(entry.memoryPatches === undefined
      ? {}
      : { memoryPatches: entry.memoryPatches }),
    ...(entry.expectedMemory === undefined
      ? {}
      : {
          memoryRanges: entry.expectedMemory.map(({ address, bytes }) => ({
            address,
            byteLength: bytes.length
          }))
        })
  });

  deepStrictEqual(
    result.completion,
    entry.expectedCompletion ?? {
      kind: "completed",
      targetEip: expectedEip
    },
    entry.name
  );
  deepStrictEqual(
    result.state,
    {
      ...initialState,
      ...entry.expectedState,
      eip: expectedEip,
      instructionCount: initialState.instructionCount + instructionCount
    },
    entry.name
  );
  deepStrictEqual(
    result.memory,
    (entry.expectedMemory ?? []).map(({ address, bytes }) => ({
      address,
      byteLength: bytes.length,
      bytes
    })),
    entry.name
  );

  return result;
}
