import {
  runResultFromExecutionState,
  type FaultOperation,
  type RunResult
} from "#x86/execution/run-result.js";
import { CompletionExit, HostExit, type DecodedExit, type DecodedHostExit } from "#wasm/exit.js";
import type { WasmCpuState } from "#wasm/host/cpu-state.js";

export function runResultFromWasmExit(state: WasmCpuState, exit: DecodedExit): RunResult {
  switch (exit.family) {
    case "completion":
      return runResultFromCompletionExit(state, exit.reason);
    case "host":
      return runResultFromHostExit(state, exit);
  }
}

function runResultFromCompletionExit(state: WasmCpuState, reason: CompletionExit): RunResult {
  switch (reason) {
    case CompletionExit.DYNAMIC_JUMP:
    case CompletionExit.LINK_STUB:
      return runResultFromExecutionState(state, { kind: "none" });
    case CompletionExit.INSTRUCTION_LIMIT:
      return runResultFromExecutionState(state, { kind: "instructionLimit" });
  }
}

function runResultFromHostExit(state: WasmCpuState, exit: DecodedHostExit): RunResult {
  switch (exit.reason) {
    case HostExit.TRAP:
      return runResultFromExecutionState(state, { kind: "hostTrap", vector: exit.payload });
    case HostExit.UNSUPPORTED:
      return runResultFromExecutionState(state, { kind: "unsupported", reason: "unsupportedOpcode" });
    case HostExit.DECODE_FAULT:
      return runResultFromExecutionState(state, { kind: "decodeFault", address: exit.payload });
    case HostExit.MEMORY_READ_FAULT:
      return stopWithMemoryFault(state, exit, "read", memoryFaultSize(exit));
    case HostExit.MEMORY_WRITE_FAULT:
      return stopWithMemoryFault(state, exit, "write", memoryFaultSize(exit));
  }
}

function memoryFaultSize(exit: DecodedHostExit): number {
  return exit.detail ?? 4;
}

function stopWithMemoryFault(
  state: WasmCpuState,
  exit: DecodedHostExit,
  faultOperation: FaultOperation,
  faultSize: number
): RunResult {
  return runResultFromExecutionState(state, {
    kind: "memoryFault",
    address: exit.payload,
    size: faultSize,
    operation: faultOperation
  });
}
