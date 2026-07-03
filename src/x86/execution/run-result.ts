export type FaultOperation = "read" | "write" | "execute";

export type UnsupportedReason =
  | "unsupportedOpcode"
  | "unsupportedPrefixSemantics"
  | "unsupportedAddressingMode"
  | "unsupportedInstruction";

export type RunStop =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "hostTrap"; vector: number }>
  | Readonly<{ kind: "unsupported"; reason: UnsupportedReason }>
  | Readonly<{ kind: "decodeFault"; address: number }>
  | Readonly<{ kind: "memoryFault"; address: number; size: number; operation: FaultOperation }>
  | Readonly<{ kind: "instructionLimit" }>;

export type RunResult = Readonly<{
  stop: RunStop;
  finalEip: number;
  instructionCount: number;
}>;

export type RunResultStateView = Readonly<{
  eip: number;
  instructionCount: number;
}>;

export function runResultFromExecutionState(
  state: RunResultStateView,
  stop: RunStop
): RunResult {
  return {
    stop,
    finalEip: state.eip,
    instructionCount: state.instructionCount
  };
}

export function runResultMatchesExecutionState(result: RunResult, state: RunResultStateView): boolean {
  return (
    result.finalEip === state.eip &&
    result.instructionCount === state.instructionCount
  );
}
