import { deepStrictEqual, strictEqual } from "node:assert";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { instantiateCompiledProgram } from "#compiler/program/instance.js";
import type { RunStop } from "#cpu/cpu.js";
import { decodeExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import { compileInterpreterProgram } from "#interpreter/program.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  readWasmCpuStateField,
  readWasmCpuStateSnapshot,
  wasmCpuStateFields,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";

export type InterpreterHarness = Readonly<{
  guestMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  runFor(instructionBudget: number): RunStop;
}>;

export type ExecutedInstruction = Readonly<{
  exit: RunStop;
  state: WasmCpuStateSnapshot;
  guestView: DataView;
}>;

export type GuestMemoryBytes = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

let compiledInterpreter:
  | ReturnType<typeof compileInterpreterProgram>
  | undefined;

export async function instantiateInterpreter(): Promise<InterpreterHarness> {
  compiledInterpreter ??= compileInterpreterProgram(testExecutionModel);
  const guestMemory = new WebAssembly.Memory({
    initial: testExecutionModel.guestMemory.memoryImport.limits.minPages
  });
  const cpuStateMemory = new WebAssembly.Memory({
    initial: testExecutionModel.cpuState.memoryImport.limits.minPages
  });
  const stateView = new DataView(cpuStateMemory.buffer);
  const guestView = new DataView(guestMemory.buffer);
  const instance = instantiateCompiledProgram(
    compiledInterpreter.program,
    new Map([
      [testExecutionModel.cpuState.resource, cpuStateMemory],
      [testExecutionModel.guestMemory.resource, guestMemory]
    ])
  );
  const run = instance.functionExports.get(compiledInterpreter.entry);

  if (typeof run !== "function") {
    throw new Error(
      `expected callable Interpreter entry ${compiledInterpreter.entry.id}`
    );
  }
  const stateStorage = createLayoutHostView(
    cpuStateMemory,
    testExecutionModel.cpuState.layout
  );

  return {
    guestMemory,
    stateView,
    guestView,
    runFor(instructionBudget): RunStop {
      stateStorage.writeField(
        instructionLimitField,
        (stateStorage.readField(instructionCountField) + instructionBudget) >>> 0
      );
      return decodeExit(run());
    }
  };
}

export async function executeInstruction(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  memory: readonly GuestMemoryBytes[] = []
): Promise<ExecutedInstruction> {
  return executeProgram(bytes, initialState, 1, memory);
}

export async function executeProgram(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  instructionBudget: number,
  memory: readonly GuestMemoryBytes[] = []
): Promise<ExecutedInstruction> {
  const interpreter = await instantiateInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  for (const entry of memory) {
    writeGuestBytes(interpreter.guestView, entry.address, entry.bytes);
  }

  const exit = interpreter.runFor(instructionBudget);
  const state = readInterpreterState(interpreter.stateView);

  return { exit, state, guestView: interpreter.guestView };
}

export function writeGuestBytes(
  view: DataView,
  address: number,
  bytes: readonly number[]
): void {
  for (let index = 0; index < bytes.length; index += 1) {
    view.setUint8(address + index, bytes[index] ?? 0);
  }
}

export function writeInterpreterState(
  view: DataView,
  state: WasmCpuStateSnapshot
): void {
  writeWasmCpuStateSnapshot(view, state);
}

export function readInterpreterState(view: DataView): WasmCpuStateSnapshot {
  return readWasmCpuStateSnapshot(view);
}

export function assertInterpreterStateEquals(
  view: DataView,
  state: WasmCpuStateSnapshot
): void {
  const expectedView = new DataView(new ArrayBuffer(view.byteLength));

  writeWasmCpuStateSnapshot(expectedView, state);
  for (const field of wasmCpuStateFields) {
    strictEqual(
      readWasmCpuStateField(view, field),
      readWasmCpuStateField(expectedView, field)
    );
  }
}

export function assertSingleInstructionExit(exit: RunStop): void {
  deepStrictEqual(exit, { kind: "instructionLimit" });
}

export function assertCompletedInstruction(
  state: WasmCpuStateSnapshot,
  expectedEip: number,
  expectedInstructionCount: number
): void {
  strictEqual(state.eip, expectedEip);
  strictEqual(state.instructionCount, expectedInstructionCount);
}
