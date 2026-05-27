import {
  runResultFromState,
  StopReason,
  type FaultOperation,
  type RunResult,
  type RunResultDetails
} from "#x86/execution/run-result.js";
import { ExitReason, type DecodedExit } from "#wasm/exit.js";
import type { WasmCpuState } from "#wasm/host/state-memory.js";

export function runResultFromWasmExit(state: WasmCpuState, exit: DecodedExit): RunResult {
  switch (exit.exitReason) {
    case ExitReason.FALLTHROUGH:
    case ExitReason.JUMP:
      state.write("stopReason", StopReason.NONE);
      return runResultFromState(state.snapshot(), StopReason.NONE);
    case ExitReason.HOST_TRAP:
      state.write("stopReason", StopReason.HOST_TRAP);
      return runResultFromState(state.snapshot(), StopReason.HOST_TRAP, { trapVector: exit.payload });
    case ExitReason.UNSUPPORTED:
      state.write("stopReason", StopReason.UNSUPPORTED);
      return runResultFromState(state.snapshot(), StopReason.UNSUPPORTED, unsupportedDetails());
    case ExitReason.DECODE_FAULT:
      state.write("stopReason", StopReason.DECODE_FAULT);
      return runResultFromState(state.snapshot(), StopReason.DECODE_FAULT, {
        faultAddress: exit.payload,
        faultOperation: "execute"
      });
    case ExitReason.MEMORY_READ_FAULT:
      return stopWithMemoryFault(state, exit, "read", memoryFaultSize(exit));
    case ExitReason.MEMORY_WRITE_FAULT:
      return stopWithMemoryFault(state, exit, "write", memoryFaultSize(exit));
    case ExitReason.INSTRUCTION_LIMIT:
      state.write("stopReason", StopReason.INSTRUCTION_LIMIT);
      return runResultFromState(state.snapshot(), StopReason.INSTRUCTION_LIMIT);
  }
}

function memoryFaultSize(exit: DecodedExit): number {
  return exit.detail ?? 4;
}

function unsupportedDetails(): RunResultDetails {
  return {
    unsupportedReason: "unsupportedOpcode"
  };
}

function stopWithMemoryFault(
  state: WasmCpuState,
  exit: DecodedExit,
  faultOperation: FaultOperation,
  faultSize: number
): RunResult {
  state.write("stopReason", StopReason.MEMORY_FAULT);
  return runResultFromState(state.snapshot(), StopReason.MEMORY_FAULT, {
    faultAddress: exit.payload,
    faultSize,
    faultOperation
  });
}
