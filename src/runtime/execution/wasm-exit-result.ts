import {
  runResultFromExecutionState,
  StopReason,
  type FaultOperation,
  type RunResult,
  type RunResultDetails
} from "#x86/execution/run-result.js";
import { ExitReason, type DecodedExit } from "#wasm/exit.js";
import type { WasmCpuState } from "#wasm/host/cpu-state.js";

export function runResultFromWasmExit(state: WasmCpuState, exit: DecodedExit): RunResult {
  switch (exit.exitReason) {
    case ExitReason.DYNAMIC_JUMP:
    case ExitReason.LINK_STUB:
      return runResultFromExecutionState(state, StopReason.NONE);
    case ExitReason.HOST_TRAP:
      return runResultFromExecutionState(state, StopReason.HOST_TRAP, { trapVector: exit.payload });
    case ExitReason.UNSUPPORTED:
      return runResultFromExecutionState(state, StopReason.UNSUPPORTED, unsupportedDetails());
    case ExitReason.DECODE_FAULT:
      return runResultFromExecutionState(state, StopReason.DECODE_FAULT, {
        faultAddress: exit.payload,
        faultOperation: "execute"
      });
    case ExitReason.MEMORY_READ_FAULT:
      return stopWithMemoryFault(state, exit, "read", memoryFaultSize(exit));
    case ExitReason.MEMORY_WRITE_FAULT:
      return stopWithMemoryFault(state, exit, "write", memoryFaultSize(exit));
    case ExitReason.INSTRUCTION_LIMIT:
      return runResultFromExecutionState(state, StopReason.INSTRUCTION_LIMIT);
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
  return runResultFromExecutionState(state, StopReason.MEMORY_FAULT, {
    faultAddress: exit.payload,
    faultSize,
    faultOperation
  });
}
