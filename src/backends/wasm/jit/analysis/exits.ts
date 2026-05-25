import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { u32 } from "#x86/numeric.js";
import type {
  JitConditionalJumpExprOp,
  JitHostTrapExprOp,
  JitJumpExprOp,
  JitMemoryGuardExprOp,
  JitNextExprOp
} from "#backends/wasm/jit/ir/bound-expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import {
  rootPath,
  type Path,
  type PathMap
} from "./paths.js";
import type { BlockProgress } from "./block-progress.js";

export type ExitPlacement = Readonly<{
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
  progress: BlockProgress;
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
  at: ExitPlacement;
  kind: ExitKind;
  reason: ExitReasonValue;
  snapshot: ExitSnapshot;
  visibleEip: ExitValue;
  payload: ExitPayload;
  staticLinkTarget?: number;
  path: Path;
}>;

type ExitBuildInputBase<
  TKind extends ExitKind,
  TOp
> = Readonly<{
  at: ExitPlacement;
  kind: TKind;
  op: TOp;
  snapshot: ExitSnapshot;
  paths: PathMap;
  targetValue?: JitValue;
  staticLinkTarget?: number;
}>;

export type ExitBuildInput =
  | ExitBuildInputBase<"memoryReadFault" | "memoryWriteFault", JitMemoryGuardExprOp>
  | ExitBuildInputBase<"fallthrough", JitNextExprOp>
  | ExitBuildInputBase<"jump", JitJumpExprOp>
  | ExitBuildInputBase<"branchTaken" | "branchNotTaken", JitConditionalJumpExprOp>
  | ExitBuildInputBase<"hostTrap", JitHostTrapExprOp>;

export function buildExit(input: ExitBuildInput): Exit {
  const { at, kind, snapshot, paths, staticLinkTarget } = input;

  return {
    id: exitId(at, kind),
    at,
    kind,
    reason: exitReasonForKind(kind),
    snapshot,
    visibleEip: visibleEipForExit(input),
    payload: payloadForExit(input),
    ...(staticLinkTarget === undefined ? {} : { staticLinkTarget: u32(staticLinkTarget) }),
    path: pathForExit(kind, paths, at)
  };
}

export function exitId(at: ExitPlacement, kind: ExitKind): string {
  return `${at.opIndex}:${kind}`;
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
  at: ExitPlacement
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

export function visibleEipForExit(input: ExitBuildInput): ExitValue {
  switch (input.kind) {
    case "memoryReadFault":
    case "memoryWriteFault":
      return { kind: "static", value: u32(input.op.faultEip) };
    case "hostTrap":
      return { kind: "static", value: u32(input.op.visibleEip) };
    default:
      return payloadForExit(input);
  }
}

export function payloadForExit(input: ExitBuildInput): ExitPayload {
  switch (input.kind) {
    case "memoryReadFault":
    case "memoryWriteFault":
      return { kind: "runtime", source: "memoryAddress" };
    case "fallthrough":
      return { kind: "static", value: u32(input.op.target.value) };
    case "jump":
    case "branchTaken":
    case "branchNotTaken": {
      return input.targetValue?.kind === "const"
        ? { kind: "static", value: u32(input.targetValue.value) }
        : { kind: "runtime", source: "controlTarget" };
    }
    case "hostTrap":
      return { kind: "runtime", source: "hostTrapVector" };
  }
}
