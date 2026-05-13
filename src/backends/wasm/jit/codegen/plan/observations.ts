import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { TargetRef } from "#x86/ir/model/types.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import type {
  JitBoundaryRef,
  JitMaterializationPathScope,
  JitObservationPayload,
  JitObservationValue,
  JitBoundaryState
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  beforeOp
} from "./boundaries.js";
import {
  type JitEffectIndex,
  jitPreInstructionExitReasonAt,
  jitPostInstructionExitReasonsAt
} from "#backends/wasm/jit/ir/effects.js";

export type JitPlannedObservationPoint = Readonly<{
  instructionIndex: number;
  opIndex: number;
  emitBoundary: JitBoundaryRef;
  observedBoundary: JitBoundaryRef;
  observedState: JitBoundaryState;
  visibleEip: JitObservationValue;
  exitReason: ExitReasonValue;
  payload: JitObservationPayload;
  pathScope: JitMaterializationPathScope;
}>;

export function jitPreInstructionObservationForOp(
  effects: JitEffectIndex,
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  opIndex: number,
  entryState: JitBoundaryState
): JitPlannedObservationPoint | undefined {
  const faultReason = jitPreInstructionExitReasonAt(effects, instructionIndex, opIndex);

  if (faultReason === undefined) {
    return undefined;
  }

  return {
    instructionIndex,
    opIndex,
    emitBoundary: beforeOp(instructionIndex, opIndex),
    observedBoundary: entryState.boundary,
    observedState: entryState,
    visibleEip: {
      kind: "static",
      value: instruction.eip
    },
    exitReason: faultReason,
    payload: {
      kind: "runtime",
      source: "memoryAddress"
    },
    pathScope: exitMaterializationPathScope(faultReason)
  };
}

export function jitPostInstructionObservationsForOp(
  effects: JitEffectIndex,
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  opIndex: number,
  postState: JitBoundaryState
): readonly JitPlannedObservationPoint[] {
  const exitReasons = jitPostInstructionExitReasonsAt(effects, instructionIndex, opIndex);

  return exitReasons.map((exitReason) => ({
    instructionIndex,
    opIndex,
    emitBoundary: beforeOp(instructionIndex, opIndex),
    observedBoundary: postState.boundary,
    observedState: postState,
    visibleEip: visibleEipForPostInstructionExit(instruction, exitReason, opIndex),
    exitReason,
    payload: payloadForPostInstructionExit(instruction, exitReason, opIndex),
    pathScope: exitMaterializationPathScope(exitReason)
  }));
}

export function countInstructionEntryObservations(
  observations: readonly Pick<JitPlannedObservationPoint, "observedBoundary">[],
  startIndex: number
): number {
  let count = 0;

  for (let index = startIndex; index < observations.length; index += 1) {
    const observation = observations[index];

    if (observation?.observedBoundary.boundaryIndex === 0) {
      count += 1;
    }
  }

  return count;
}

function visibleEipForPostInstructionExit(
  instruction: JitIrBlockInstruction,
  exitReason: ExitReasonValue,
  opIndex: number
): JitObservationValue {
  switch (exitReason) {
    case ExitReason.HOST_TRAP:
      return {
        kind: "static",
        value: instruction.nextEip
      };
    default:
      return payloadForPostInstructionExit(instruction, exitReason, opIndex);
  }
}

function payloadForPostInstructionExit(
  instruction: JitIrBlockInstruction,
  exitReason: ExitReasonValue,
  opIndex: number
): JitObservationPayload {
  const op = instruction.ir[opIndex];

  if (op === undefined) {
    throw new Error(`missing JIT IR op while planning JIT exit payload: ${instruction.instructionId}:${opIndex}`);
  }

  switch (exitReason) {
    case ExitReason.FALLTHROUGH:
      return { kind: "static", value: instruction.nextEip };
    case ExitReason.JUMP:
      return controlTargetObservationValue(op.op === "jump" ? op.target : undefined, instruction);
    case ExitReason.BRANCH_TAKEN:
      return controlTargetObservationValue(op.op === "conditionalJump" ? op.taken : undefined, instruction);
    case ExitReason.BRANCH_NOT_TAKEN:
      return controlTargetObservationValue(op.op === "conditionalJump" ? op.notTaken : undefined, instruction);
    case ExitReason.HOST_TRAP:
      return { kind: "runtime", source: "hostTrapVector" };
    default:
      return { kind: "runtime", source: "controlTarget" };
  }
}

function controlTargetObservationValue(
  target: TargetRef | undefined,
  instruction: JitIrBlockInstruction
): JitObservationValue {
  const staticTarget = target === undefined
    ? undefined
    : staticControlTarget(target, instruction);

  return staticTarget === undefined
    ? { kind: "runtime", source: "controlTarget" }
    : { kind: "static", value: staticTarget };
}

function staticControlTarget(target: TargetRef, instruction: JitIrBlockInstruction): number | undefined {
  switch (target.kind) {
    case "const":
      return u32(target.value);
    case "nextEip":
      return u32(instruction.nextEip);
    case "var":
      return staticConstVarValue(target.id, instruction);
  }
}

function staticConstVarValue(varId: number, instruction: JitIrBlockInstruction): number | undefined {
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

function exitMaterializationPathScope(exitReason: ExitReasonValue): JitMaterializationPathScope {
  switch (exitReason) {
    case ExitReason.BRANCH_TAKEN:
      return "taken";
    case ExitReason.BRANCH_NOT_TAKEN:
      return "notTaken";
    default:
      return "deferredExit";
  }
}
