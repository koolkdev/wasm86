import type { RunStop } from "#cpu/cpu.js";

export type RuntimeRunStop = RunStop | Readonly<{ kind: "none" }>;

export type RuntimeRunResult = Readonly<{
  stop: RuntimeRunStop;
  finalEip: number;
  instructionCount: number;
}>;

export type RuntimeRunResultStateView = Readonly<{
  eip: number;
  instructionCount: number;
}>;

export type RuntimeEngineUnavailableReason =
  | "no-compiled-block"
  | "unsupported-block"
  | "unsupported-codegen";

export type RuntimeEngineResult =
  | Readonly<{ kind: "done"; result: RuntimeRunResult }>
  | Readonly<{ kind: "unavailable"; reason: RuntimeEngineUnavailableReason }>;

export function engineDone(result: RuntimeRunResult): RuntimeEngineResult {
  return { kind: "done", result };
}

export function engineUnavailable(reason: RuntimeEngineUnavailableReason): RuntimeEngineResult {
  return { kind: "unavailable", reason };
}

export function runtimeRunResultFromExecutionState(
  state: RuntimeRunResultStateView,
  stop: RuntimeRunStop
): RuntimeRunResult {
  return {
    stop,
    finalEip: state.eip,
    instructionCount: state.instructionCount
  };
}
