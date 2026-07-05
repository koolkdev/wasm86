import { assert } from "#common/assert.js";
import {
  runResultFromExecutionState,
  type RunStop,
  type RunResult
} from "#x86/execution/run-result.js";
import { segmentRegisters } from "#x86/types.js";
import { CompletionExit, HostExit, type DecodedExit, type DecodedHostExit } from "#wasm/exit.js";
import type { WasmCpuState } from "#wasm/host/cpu-state.js";

export function runResultFromWasmExit(state: WasmCpuState, exit: DecodedExit): RunResult {
  switch (exit.family) {
    case "completion":
      return runResultFromCompletionExit(state, exit.reason);
    case "host":
      return runResultFromHostExit(state, exit);
    case "cpuException":
      return runResultFromExecutionState(state, { kind: "cpuException", exception: exit.exception });
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
    case HostExit.SEGMENT_LOAD:
      return runResultFromExecutionState(state, decodeSegmentLoadStop(exit.payload));
  }
}

function decodeSegmentLoadStop(payload: number): Extract<RunStop, { kind: "segmentLoad" }> {
  const segment = segmentRegisters[(payload >>> 16) & 0xffff];

  assert(segment !== undefined, `segment-load exit has invalid segment index: ${payload >>> 16}`);

  return {
    kind: "segmentLoad",
    segment,
    selector: payload & 0xffff
  };
}
