import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { ExitReason } from "#backends/wasm/exit.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { TargetRef } from "#x86/ir/model/types.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import {
  rootPath,
  type Path,
  type PathMap
} from "./paths.js";

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
  instructionCountDelta: number;
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
  path: Path;
}>;

export type ExitBuildInput = Readonly<{
  instruction: JitInstruction;
  at: Placement;
  kind: ExitKind;
  snapshot: ExitSnapshot;
  paths: PathMap;
}>;

export function buildExit(input: ExitBuildInput): Exit {
  const { instruction, at, kind, snapshot, paths } = input;

  return {
    id: exitId(at, kind),
    at,
    kind,
    reason: exitReasonForKind(kind),
    snapshot,
    visibleEip: visibleEipForExit(instruction, kind, at.opIndex),
    payload: payloadForExit(instruction, kind, at.opIndex),
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
  instruction: JitInstruction,
  kind: ExitKind,
  opIndex: number
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
      return payloadForExit(instruction, kind, opIndex);
  }
}

export function payloadForExit(
  instruction: JitInstruction,
  kind: ExitKind,
  opIndex: number
): ExitPayload {
  const op = instruction.ir[opIndex];

  if (op === undefined) {
    throw new Error(`missing JIT IR op while planning JIT exit payload: ${instruction.instructionId}:${opIndex}`);
  }

  switch (kind) {
    case "memoryReadFault":
    case "memoryWriteFault":
      return { kind: "runtime", source: "memoryAddress" };
    case "fallthrough":
      return { kind: "static", value: instruction.nextEip };
    case "jump":
      return controlTargetExitValue(op.op === "jump" ? op.target : undefined, instruction);
    case "branchTaken":
      return controlTargetExitValue(op.op === "conditionalJump" ? op.taken : undefined, instruction);
    case "branchNotTaken":
      return controlTargetExitValue(op.op === "conditionalJump" ? op.notTaken : undefined, instruction);
    case "hostTrap":
      return { kind: "runtime", source: "hostTrapVector" };
  }
}

function controlTargetExitValue(
  target: TargetRef | undefined,
  instruction: JitInstruction
): ExitValue {
  const staticTarget = target === undefined
    ? undefined
    : staticControlTarget(target, instruction);

  return staticTarget === undefined
    ? { kind: "runtime", source: "controlTarget" }
    : { kind: "static", value: staticTarget };
}

function staticControlTarget(target: TargetRef, instruction: JitInstruction): number | undefined {
  switch (target.kind) {
    case "const":
      return u32(target.value);
    case "nextEip":
      return u32(instruction.nextEip);
    case "var":
      return staticConstVarValue(target.id, instruction);
  }
}

function staticConstVarValue(varId: number, instruction: JitInstruction): number | undefined {
  for (const op of instruction.ir) {
    if (op.op === "value.const" && op.dst.id === varId) {
      return u32(op.value);
    }

    if (op.op === "get" && op.dst.id === varId && op.source.kind === "operand") {
      const binding = instruction.operands[op.source.index];

      if (binding?.kind === "static.relTarget") {
        return u32(binding.target);
      }
    }
  }

  return undefined;
}
