import { assert } from "#common/assert.js";
import type { RunStop } from "#cpu/cpu.js";
import { segmentRegisters } from "#core/types.js";
import {
  runtimeRunResultFromExecutionState,
  type RuntimeRunResult
} from "./engine-result.js";
import { CompletionExit, HostExit, type DecodedExit, type DecodedHostExit } from "#wasm/exit.js";
import type { WasmCpuState } from "#wasm/host/cpu-state.js";

export function runResultFromWasmExit(state: WasmCpuState, exit: DecodedExit): RuntimeRunResult {
  switch (exit.family) {
    case "completion":
      return runResultFromCompletionExit(state, exit.reason);
    case "host":
      return runResultFromHostExit(state, exit);
    case "cpuException":
      return runtimeRunResultFromExecutionState(state, { kind: "cpuException", exception: exit.exception });
  }
}

function runResultFromCompletionExit(state: WasmCpuState, reason: CompletionExit): RuntimeRunResult {
  switch (reason) {
    case CompletionExit.DYNAMIC_JUMP:
    case CompletionExit.LINK_STUB:
      return runtimeRunResultFromExecutionState(state, { kind: "none" });
    case CompletionExit.INSTRUCTION_LIMIT:
      return runtimeRunResultFromExecutionState(state, { kind: "instructionLimit" });
  }
}

function runResultFromHostExit(state: WasmCpuState, exit: DecodedHostExit): RuntimeRunResult {
  switch (exit.reason) {
    case HostExit.TRAP:
      return runtimeRunResultFromExecutionState(state, { kind: "hostTrap", vector: exit.payload });
    case HostExit.UNSUPPORTED:
      return runtimeRunResultFromExecutionState(state, { kind: "unsupported", reason: "unsupportedOpcode" });
    case HostExit.SEGMENT_LOAD:
      return runtimeRunResultFromExecutionState(state, decodeSegmentLoadStop(exit.payload));
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
