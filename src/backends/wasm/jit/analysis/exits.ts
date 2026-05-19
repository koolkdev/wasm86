import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { InstructionMetadata } from "#backends/wasm/jit/ir/types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import {
  rootPath,
  type Path,
  type PathMap
} from "./paths.js";
import type { InstructionProgress } from "./instruction-progress.js";

export type Placement = Readonly<{
  instructionIndex: number;
  opIndex: number;
}>;

export type ExitKind =
  | "memoryReadFault"
  | "memoryWriteFault"
  | "fallthrough"
  | "jump"
  | "branchTaken"
  | "branchNotTaken"
  | "hostTrap";

export type ExitSnapshot = Readonly<{
  progress: InstructionProgress;
  valueState: JitValueStateSnapshot;
}>;

export type ExitRuntimeSource =
  | "controlTarget"
  | "hostTrapVector"
  | "memoryAddress";

export type ExitValue =
  | Readonly<{ kind: "static"; value: number }>
  | Readonly<{ kind: "runtime"; source: ExitRuntimeSource }>;

export type ExitPayload = ExitValue;

export type Exit = Readonly<{
  id: string;
  at: Placement;
  kind: ExitKind;
  reason: ExitReasonValue;
  snapshot: ExitSnapshot;
  visibleEip: ExitValue;
  payload: ExitPayload;
  staticLinkTarget?: number;
  path: Path;
}>;

export type ExitBuildInput = Readonly<{
  instruction: InstructionMetadata;
  at: Placement;
  kind: ExitKind;
  snapshot: ExitSnapshot;
  paths: PathMap;
  targetValue?: JitValue;
  staticLinkTarget?: number;
}>;

export function buildExit(input: ExitBuildInput): Exit {
  const { instruction, at, kind, snapshot, paths, targetValue, staticLinkTarget } = input;

  return {
    id: exitId(at, kind),
    at,
    kind,
    reason: exitReasonForKind(kind),
    snapshot,
    visibleEip: visibleEipForExit(instruction, kind, targetValue),
    payload: payloadForExit(instruction, kind, targetValue),
    ...(staticLinkTarget === undefined ? {} : { staticLinkTarget: u32(staticLinkTarget) }),
    path: pathForExit(kind, paths, at)
  };
}

export function exitId(at: Placement, kind: ExitKind): string {
  return `${at.instructionIndex}:${at.opIndex}:${kind}`;
}

export function exitReasonForKind(kind: ExitKind): ExitReasonValue {
  switch (kind) {
    case "memoryReadFault":
      return ExitReason.MEMORY_READ_FAULT;
    case "memoryWriteFault":
      return ExitReason.MEMORY_WRITE_FAULT;
    case "fallthrough":
      return ExitReason.FALLTHROUGH;
    case "jump":
    case "branchTaken":
    case "branchNotTaken":
      return ExitReason.JUMP;
    case "hostTrap":
      return ExitReason.HOST_TRAP;
  }
}

export function pathForExit(
  kind: ExitKind,
  paths: PathMap,
  at: Placement
): Path {
  switch (kind) {
    case "branchTaken":
      return paths.get(at.opIndex)!.taken;
    case "branchNotTaken":
      return paths.get(at.opIndex)!.notTaken;
    default:
      return rootPath();
  }
}

export function visibleEipForExit(
  instruction: InstructionMetadata,
  kind: ExitKind,
  targetValue?: JitValue
): ExitValue {
  switch (kind) {
    case "memoryReadFault":
    case "memoryWriteFault":
      return {
        kind: "static",
        value: instruction.eip
      };
    case "hostTrap":
      return {
        kind: "static",
        value: instruction.nextEip
      };
    default:
      return payloadForExit(instruction, kind, targetValue);
  }
}

export function payloadForExit(
  instruction: InstructionMetadata,
  kind: ExitKind,
  targetValue?: JitValue
): ExitPayload {
  switch (kind) {
    case "memoryReadFault":
    case "memoryWriteFault":
      return { kind: "runtime", source: "memoryAddress" };
    case "fallthrough":
      return { kind: "static", value: instruction.nextEip };
    case "jump":
    case "branchTaken":
    case "branchNotTaken": {
      return targetValue?.kind === "const"
        ? { kind: "static", value: u32(targetValue.value) }
        : { kind: "runtime", source: "controlTarget" };
    }
    case "hostTrap":
      return { kind: "runtime", source: "hostTrapVector" };
  }
}
