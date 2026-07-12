import type { RunResult } from "#driver/results.js";

export type RuntimeEngineUnavailableReason =
  | "no-compiled-block"
  | "unsupported-block"
  | "unsupported-codegen";

export type RuntimeEngineResult =
  | Readonly<{ kind: "done"; result: RunResult }>
  | Readonly<{ kind: "unavailable"; reason: RuntimeEngineUnavailableReason }>;

export function engineDone(result: RunResult): RuntimeEngineResult {
  return { kind: "done", result };
}

export function engineUnavailable(reason: RuntimeEngineUnavailableReason): RuntimeEngineResult {
  return { kind: "unavailable", reason };
}
