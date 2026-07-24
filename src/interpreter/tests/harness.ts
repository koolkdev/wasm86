import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import type { RunStop } from "#cpu/cpu.js";
import { decodeExit } from "#cpu/exit.js";
import {
  instructionCountField,
  instructionLimitField
} from "#cpu/instruction-count.js";
import { compileInterpreterProgram } from "#interpreter/program.js";
import type { WasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  readWasmCpuStateSnapshot,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import { createTestWasmMemories } from "#test/support/wasm-memories.js";

type InterpreterHarness = Readonly<{
  guestMemory: WebAssembly.Memory;
  stateView: DataView;
  guestView: DataView;
  runFor(instructionBudget: number): RunStop;
}>;

type ExecutedInstruction = Readonly<{
  exit: RunStop;
  state: WasmCpuStateSnapshot;
  guestView: DataView;
}>;

type GuestMemoryBytes = Readonly<{
  address: number;
  bytes: readonly number[];
}>;

let compiledInterpreter:
  | ReturnType<typeof compileInterpreterProgram>
  | undefined;

export function instantiateInterpreter(): InterpreterHarness {
  compiledInterpreter ??= compileInterpreterProgram(testExecutionModel);
  const memories = createTestWasmMemories();
  const stateView = new DataView(memories.cpuStateMemory.buffer);
  const guestView = new DataView(memories.guestMemory.buffer);
  const instance = instantiateCompiledProgram(
    compiledInterpreter.program,
    {
      memories: memories.programMemories,
      functions: new Map()
    }
  );
  const run = instance.functionExports.get(compiledInterpreter.entry);

  if (typeof run !== "function") {
    throw new Error(
      `expected callable Interpreter entry ${compiledInterpreter.entry.id}`
    );
  }
  const stateStorage = createLayoutHostView(
    memories.cpuStateMemory,
    testExecutionModel.cpuState.layout
  );

  return {
    guestMemory: memories.guestMemory,
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

export function executeInstruction(
  bytes: readonly number[],
  initialState: WasmCpuStateSnapshot,
  memory: readonly GuestMemoryBytes[] = []
): ExecutedInstruction {
  const interpreter = instantiateInterpreter();

  writeWasmCpuStateSnapshot(interpreter.stateView, initialState);
  writeGuestBytes(interpreter.guestView, initialState.eip, bytes);
  for (const entry of memory) {
    writeGuestBytes(interpreter.guestView, entry.address, entry.bytes);
  }

  const exit = interpreter.runFor(1);
  const state = readWasmCpuStateSnapshot(interpreter.stateView);

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
