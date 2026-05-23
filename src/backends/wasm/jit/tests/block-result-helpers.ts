import { deepStrictEqual } from "node:assert";

import { runIsaBytes } from "#backends/direct/tests/helpers.js";
import {
  instantiateWasmInterpreter,
  writeGuestBytes
} from "#backends/wasm/interpreter/tests/support.js";
import { ExitReason, type DecodedExit } from "#backends/wasm/exit.js";
import { readWasmCpuState, writeWasmCpuState } from "#backends/wasm/state-layout.js";
import { StopReason, type RunResult } from "#x86/execution/run-result.js";
import { decodeBytes, ok } from "#x86/isa/decoder/tests/helpers.js";
import { ArrayBufferGuestMemory } from "#x86/memory/guest-memory.js";
import {
  cloneCpuState,
  cpuArithmeticFlags,
  eflagsMask,
  type CpuState
} from "#x86/state/cpu-state.js";
import { runJitBlock } from "./helpers.js";

export type MemoryBytes = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

export type MemoryWatch = Readonly<{
  address: number;
  byteLength: number;
}>;

export type BlockRunCase = Readonly<{
  bytes: readonly number[];
  initialState: CpuState;
  memory?: readonly MemoryBytes[];
  watchMemory?: readonly MemoryWatch[];
  additionalRunners?: readonly BlockRunner[];
}>;

export type BlockRunner = Readonly<{
  name: string;
  run(testCase: BlockRunCase): Promise<BlockSnapshot>;
}>;

export type BlockSnapshot = Readonly<{
  state: CpuSnapshot;
  exit: DecodedExit;
  memory: readonly MemorySnapshot[];
}>;

type CpuSnapshot = Readonly<{
  eax: number;
  ecx: number;
  edx: number;
  ebx: number;
  esp: number;
  ebp: number;
  esi: number;
  edi: number;
  eip: number;
  eflags: number;
  arithmeticEflags: number;
  instructionCount: number;
}>;

type MemorySnapshot = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

export async function assertBlockResult(
  name: string,
  testCase: BlockRunCase
): Promise<BlockSnapshot> {
  assertWatchedMemoryDoesNotOverlapInstructions(testCase);

  const runners: readonly BlockRunner[] = [
    directRunner,
    wasmInterpreterRunner,
    wasmJitRunner,
    ...(testCase.additionalRunners ?? [])
  ];
  const snapshots = await Promise.all(runners.map(async (runner) => ({
    runner: runner.name,
    snapshot: await runner.run(testCase)
  })));
  const expected = snapshots[0]?.snapshot;

  if (expected === undefined) {
    throw new Error("missing block result snapshot");
  }

  for (const { runner, snapshot } of snapshots.slice(1)) {
    deepStrictEqual(snapshot, expected, `${name}: ${runner}`);
  }

  return expected;
}

const directRunner: BlockRunner = {
  name: "direct",
  run: async (testCase) => {
    const memory = createDirectMemory(testCase);
    const state = cloneCpuState(testCase.initialState);
    const result = runIsaBytes(state, testCase.bytes, {
      memory,
      instructionLimit: decodedInstructionCount(testCase.bytes, state.eip)
    });

    return snapshotFor(
      state,
      normalizeFallthroughExit(directExit(result), state, testCase),
      readDirectMemory(memory, memoryWatches(testCase))
    );
  }
};

const wasmInterpreterRunner: BlockRunner = {
  name: "wasm-interpreter",
  run: async (testCase) => {
    const interpreter = await instantiateWasmInterpreter();
    const state = cloneCpuState(testCase.initialState);

    writeWasmCpuState(interpreter.stateView, state);
    writeGuestBytes(interpreter.guestView, state.eip, testCase.bytes);
    writeWasmMemory(interpreter.guestView, testCase.memory ?? []);
    const exit = interpreter.run(decodedInstructionCount(testCase.bytes, state.eip));
    const finalState = readWasmCpuState(interpreter.stateView);

    return snapshotFor(
      finalState,
      normalizeFallthroughExit(exit, finalState, testCase),
      readWasmMemory(interpreter.guestView, memoryWatches(testCase))
    );
  }
};

const wasmJitRunner: BlockRunner = {
  name: "wasm-jit",
  run: async (testCase) => {
    const result = await runJitBlock(testCase.bytes, cloneCpuState(testCase.initialState), testCase.memory ?? []);

    return snapshotFor(result.state, result.exit, readWasmMemory(result.guestView, memoryWatches(testCase)));
  }
};

function createDirectMemory(testCase: BlockRunCase): ArrayBufferGuestMemory {
  const memory = new ArrayBufferGuestMemory(directMemoryByteLength(testCase));

  for (const entry of testCase.memory ?? []) {
    for (let index = 0; index < entry.bytes.length; index += 1) {
      const write = memory.writeU8(entry.address + index, entry.bytes[index] ?? 0);

      if (!write.ok) {
        throw new Error(`direct memory fixture write fault at 0x${write.fault.faultAddress.toString(16)}`);
      }
    }
  }

  return memory;
}

function directMemoryByteLength(testCase: BlockRunCase): number {
  return Math.max(
    testCase.initialState.eip + testCase.bytes.length,
    ...memoryWatches(testCase).map((watch) => watch.address + watch.byteLength),
    ...(testCase.memory ?? []).map((entry) => entry.address + entry.bytes.length)
  );
}

function directExit(result: RunResult): DecodedExit {
  switch (result.stopReason) {
    case StopReason.NONE:
      return { exitReason: ExitReason.FALLTHROUGH, payload: result.finalEip };
    case StopReason.HOST_TRAP:
      return { exitReason: ExitReason.HOST_TRAP, payload: result.trapVector ?? 0 };
    case StopReason.MEMORY_FAULT:
      return {
        exitReason: result.faultOperation === "write" ? ExitReason.MEMORY_WRITE_FAULT : ExitReason.MEMORY_READ_FAULT,
        payload: result.faultAddress ?? 0,
        detail: result.faultSize ?? 0
      };
    case StopReason.UNSUPPORTED:
      return { exitReason: ExitReason.UNSUPPORTED, payload: result.unsupportedByte ?? 0 };
    case StopReason.DECODE_FAULT:
      return { exitReason: ExitReason.DECODE_FAULT, payload: result.faultAddress ?? result.finalEip };
    case StopReason.INSTRUCTION_LIMIT:
      return { exitReason: ExitReason.INSTRUCTION_LIMIT, payload: 0 };
  }
}

function normalizeFallthroughExit(
  exit: DecodedExit,
  state: CpuState,
  testCase: BlockRunCase
): DecodedExit {
  const expectedFallthrough = testCase.initialState.eip + testCase.bytes.length;

  return exit.exitReason === ExitReason.INSTRUCTION_LIMIT && state.eip === expectedFallthrough
    ? { exitReason: ExitReason.FALLTHROUGH, payload: expectedFallthrough }
    : exit;
}

function snapshotFor(
  state: CpuState,
  exit: DecodedExit,
  memory: readonly MemorySnapshot[]
): BlockSnapshot {
  return {
    state: {
      eax: state.eax,
      ecx: state.ecx,
      edx: state.edx,
      ebx: state.ebx,
      esp: state.esp,
      ebp: state.ebp,
      esi: state.esi,
      edi: state.edi,
      eip: state.eip,
      eflags: state.eflags,
      arithmeticEflags: arithmeticEflags(state.eflags),
      instructionCount: state.instructionCount
    },
    exit,
    memory
  };
}

function arithmeticEflags(eflags: number): number {
  return cpuArithmeticFlags.reduce((mask, flag) => mask | (eflags & eflagsMask[flag]), 0) >>> 0;
}

function memoryWatches(testCase: BlockRunCase): readonly MemoryWatch[] {
  return testCase.watchMemory ?? (testCase.memory ?? []).map((entry) => ({
    address: entry.address,
    byteLength: entry.bytes.length
  }));
}

function assertWatchedMemoryDoesNotOverlapInstructions(testCase: BlockRunCase): void {
  const instructionStart = testCase.initialState.eip;
  const instructionEnd = instructionStart + testCase.bytes.length;

  for (const watch of memoryWatches(testCase)) {
    const watchEnd = watch.address + watch.byteLength;

    if (watch.address < instructionEnd && instructionStart < watchEnd) {
      throw new Error(
        `block memory watches must not overlap instruction bytes: ` +
          `[0x${watch.address.toString(16)}, 0x${watchEnd.toString(16)}) overlaps ` +
          `[0x${instructionStart.toString(16)}, 0x${instructionEnd.toString(16)})`
      );
    }
  }
}

function readDirectMemory(
  memory: ArrayBufferGuestMemory,
  watches: readonly MemoryWatch[]
): readonly MemorySnapshot[] {
  return watches.map((watch) => ({
    address: watch.address,
    bytes: Array.from({ length: watch.byteLength }, (_, index) => {
      const read = memory.readU8(watch.address + index);

      if (!read.ok) {
        throw new Error(`direct memory watch read fault at 0x${read.fault.faultAddress.toString(16)}`);
      }

      return read.value;
    })
  }));
}

function writeWasmMemory(view: DataView, memory: readonly MemoryBytes[]): void {
  for (const entry of memory) {
    writeGuestBytes(view, entry.address, entry.bytes);
  }
}

function readWasmMemory(
  view: DataView,
  watches: readonly MemoryWatch[]
): readonly MemorySnapshot[] {
  return watches.map((watch) => ({
    address: watch.address,
    bytes: Array.from({ length: watch.byteLength }, (_, index) => view.getUint8(watch.address + index))
  }));
}

function decodedInstructionCount(bytes: readonly number[], eip: number): number {
  let count = 0;
  let offset = 0;

  while (offset < bytes.length) {
    const decoded = ok(decodeBytes(bytes.slice(offset), eip + offset));

    count += 1;
    offset = decoded.nextEip - eip;
  }

  return count;
}
