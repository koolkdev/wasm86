import { deepStrictEqual, strictEqual } from "node:assert";

import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import type { RunStop } from "#cpu/cpu.js";
import {
  instantiateInterpreterCompiledModule,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { encodeInterpreterModule } from "#engines/interpreter/module.js";

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

export async function instantiateWasmInterpreter(): Promise<InterpreterModuleInstance> {
  interpreterModule ??= new WebAssembly.Module(encodeInterpreterModule().bytes);
  return instantiateInterpreterCompiledModule(interpreterModule);
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
  fuel: number,
  memory: readonly GuestMemoryBytes[] = []
): Promise<ExecutedInstruction> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  for (const entry of memory) {
    writeGuestBytes(interpreter.guestView, entry.address, entry.bytes);
  }

  const exit = interpreter.run(fuel);
  const state = readInterpreterState(interpreter.stateView);

  return { exit, state, guestView: interpreter.guestView };
}

export function writeGuestBytes(view: DataView, address: number, bytes: readonly number[]): void {
  for (let index = 0; index < bytes.length; index += 1) {
    view.setUint8(address + index, bytes[index] ?? 0);
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
