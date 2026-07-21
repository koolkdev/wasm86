import { deepStrictEqual, strictEqual } from "node:assert";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import type { RunStop } from "#cpu/cpu.js";
import { decodeExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import {
  cpuState,
  cpuStateResourceDefinition
} from "#cpu/state.js";
import { encodeInterpreterModule } from "#interpreter/module.js";
import { interpreterRunExportName } from "#interpreter/program.js";
import { guestMemoryResourceDefinition } from "#memory/resource.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  readWasmCpuStateField,
  readWasmCpuStateSnapshot,
  wasmCpuStateFields,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { programImportModuleName } from "#compiler/program/imports.js";
import { createGuestMemory } from "#wasm/tests/helpers.js";

export type InterpreterHarness = Readonly<{
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
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

let interpreterModule: WebAssembly.Module | undefined;

export async function instantiateInterpreter(): Promise<InterpreterHarness> {
  interpreterModule ??= new WebAssembly.Module(encodeInterpreterModule());
  const guestMemory = createGuestMemory();
  const cpuStateMemory = new WebAssembly.Memory({ initial: 1 });
  const stateView = new DataView(cpuStateMemory.buffer);
  const guestView = new DataView(guestMemory.buffer);
  const instance = await WebAssembly.instantiate(interpreterModule, {
    [programImportModuleName]: {
      [cpuStateResourceDefinition.name]: cpuStateMemory,
      [guestMemoryResourceDefinition.name]: guestMemory
    }
  });
  const run = readExportedRun(instance);
  const stateStorage = createLayoutHostView(cpuStateMemory, cpuState.layout);

  return {
    module: interpreterModule,
    instance,
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

function readExportedRun(instance: WebAssembly.Instance): () => bigint {
  const value = instance.exports[interpreterRunExportName];

  if (typeof value !== "function") {
    throw new Error(`expected exported function '${interpreterRunExportName}'`);
  }
  return value as () => bigint;
}
