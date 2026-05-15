import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { TargetRef } from "#x86/ir/model/types.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import type {
  JitExitStateSnapshot,
  JitObservationPayload,
  JitObservationValue,
  JitInstructionState
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  rootValuePathScope,
  type JitValuePathScope
} from "./control-paths.js";
import {
  jitOpExitReason,
  type JitOpExitKind
} from "#backends/wasm/jit/ir/effect-primitives.js";

export type JitPlannedObservationPoint = Readonly<{
  instructionIndex: number;
  opIndex: number;
  observedState: JitExitStateSnapshot;
  visibleEip: JitObservationValue;
  exitReason: ExitReasonValue;
  payload: JitObservationPayload;
  pathScope: JitValuePathScope;
}>;

export function jitExitObservationForOp(
  instruction: JitInstruction,
  instructionIndex: number,
  opIndex: number,
  exit: JitOpExitKind,
  observedState: JitExitStateSnapshot,
  controlPathScopes: JitInstructionState["controlPathScopes"]
): JitPlannedObservationPoint {
  return {
    instructionIndex,
    opIndex,
    observedState,
    visibleEip: visibleEipForOpExit(instruction, exit, opIndex),
    exitReason: jitOpExitReason(exit),
    payload: payloadForOpExit(instruction, exit, opIndex),
    pathScope: observationPathScope(instructionIndex, opIndex, exit, controlPathScopes)
  };
}

function visibleEipForOpExit(
  instruction: JitInstruction,
  exit: JitOpExitKind,
  opIndex: number
): JitObservationValue {
  switch (exit) {
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
      return payloadForOpExit(instruction, exit, opIndex);
  }
}

function payloadForOpExit(
  instruction: JitInstruction,
  exit: JitOpExitKind,
  opIndex: number
): JitObservationPayload {
  const op = instruction.ir[opIndex];

  if (op === undefined) {
    throw new Error(`missing JIT IR op while planning JIT exit payload: ${instruction.instructionId}:${opIndex}`);
  }

  switch (exit) {
    case "memoryReadFault":
    case "memoryWriteFault":
      return { kind: "runtime", source: "memoryAddress" };
    case "fallthrough":
      return { kind: "static", value: instruction.nextEip };
    case "jump":
      return controlTargetObservationValue(op.op === "jump" ? op.target : undefined, instruction);
    case "branchTaken":
      return controlTargetObservationValue(op.op === "conditionalJump" ? op.taken : undefined, instruction);
    case "branchNotTaken":
      return controlTargetObservationValue(op.op === "conditionalJump" ? op.notTaken : undefined, instruction);
    case "hostTrap":
      return { kind: "runtime", source: "hostTrapVector" };
    default:
      return { kind: "runtime", source: "controlTarget" };
  }
}

function controlTargetObservationValue(
  target: TargetRef | undefined,
  instruction: JitInstruction
): JitObservationValue {
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

function observationPathScope(
  instructionIndex: number,
  opIndex: number,
  exit: JitOpExitKind,
  controlPathScopes: JitInstructionState["controlPathScopes"]
): JitValuePathScope {
  switch (exit) {
    case "branchTaken":
      return requiredBranchPathScopes(
        controlPathScopes,
        instructionIndex,
        opIndex
      ).taken;
    case "branchNotTaken":
      return requiredBranchPathScopes(
        controlPathScopes,
        instructionIndex,
        opIndex
      ).notTaken;
    default:
      return rootValuePathScope();
  }
}

function requiredBranchPathScopes(
  controlPathScopes: JitInstructionState["controlPathScopes"],
  instructionIndex: number,
  opIndex: number
) {
  const pathScopes = controlPathScopes.get(opIndex);

  if (pathScopes === undefined) {
    throw new Error(`missing JIT branch path scopes for source op: ${instructionIndex}:${opIndex}`);
  }

  return pathScopes;
}
