import { deepStrictEqual, strictEqual } from "node:assert";

import type { CpuState } from "#x86/state/cpu-state.js";
import {
  instantiateInterpreterCompiledModule,
  readInterpreterState,
  writeInterpreterState,
  type InterpreterModuleInstance
} from "./interpreter-helpers.js";
import { ExitReason, type DecodedExit } from "#wasm/exit.js";
import { encodeInterpreterModule } from "#engines/interpreter/module.js";

export type ExecutedInstruction = Readonly<{
  exit: DecodedExit;
  state: CpuState;
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
  initialState: CpuState,
  memory: readonly GuestMemoryBytes[] = []
): Promise<ExecutedInstruction> {
  const interpreter = await instantiateWasmInterpreter();

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  for (const entry of memory) {
    writeGuestBytes(interpreter.guestView, entry.address, entry.bytes);
  }

  const exit = interpreter.run(1);
  const state = readInterpreterState(interpreter.stateView);

  return { exit, state, guestView: interpreter.guestView };
}

export function writeGuestBytes(view: DataView, address: number, bytes: readonly number[]): void {
  for (let index = 0; index < bytes.length; index += 1) {
    view.setUint8(address + index, bytes[index] ?? 0);
  }
}

export function assertSingleInstructionExit(exit: DecodedExit): void {
  deepStrictEqual(exit, { exitReason: ExitReason.INSTRUCTION_LIMIT, payload: 0 });
}

export function assertCompletedInstruction(
  state: CpuState,
  expectedEip: number,
  expectedInstructionCount: number
): void {
  strictEqual(state.eip, expectedEip);
  strictEqual(state.instructionCount, expectedInstructionCount);
}
