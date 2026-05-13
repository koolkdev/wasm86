import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
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
  jitPostInstructionExitsAt
} from "#backends/wasm/jit/ir/effects.js";
import type { JitPostInstructionExit } from "#backends/wasm/jit/ir/effect-primitives.js";

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
    pathScope: "deferredExit"
  };
}

export function jitPostInstructionObservationsForOp(
  effects: JitEffectIndex,
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  opIndex: number,
  postState: JitBoundaryState
): readonly JitPlannedObservationPoint[] {
  const exits = jitPostInstructionExitsAt(effects, instructionIndex, opIndex);

  return exits.map((exit) => ({
    instructionIndex,
    opIndex,
    emitBoundary: beforeOp(instructionIndex, opIndex),
    observedBoundary: postState.boundary,
    observedState: postState,
    visibleEip: visibleEipForPostInstructionExit(instruction, exit, opIndex),
    exitReason: exit.exitReason,
    payload: payloadForPostInstructionExit(instruction, exit, opIndex),
    pathScope: exitMaterializationPathScope(exit)
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
  exit: JitPostInstructionExit,
  opIndex: number
): JitObservationValue {
  switch (exit.kind) {
    case "hostTrap":
      return {
        kind: "static",
        value: instruction.nextEip
      };
    default:
      return payloadForPostInstructionExit(instruction, exit, opIndex);
  }
}

function payloadForPostInstructionExit(
  instruction: JitIrBlockInstruction,
  exit: JitPostInstructionExit,
  opIndex: number
): JitObservationPayload {
  const op = instruction.ir[opIndex];

  if (op === undefined) {
    throw new Error(`missing JIT IR op while planning JIT exit payload: ${instruction.instructionId}:${opIndex}`);
  }

  switch (exit.kind) {
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

function exitMaterializationPathScope(exit: JitPostInstructionExit): JitMaterializationPathScope {
  switch (exit.kind) {
    case "branchTaken":
      return "taken";
    case "branchNotTaken":
      return "notTaken";
    default:
      return "deferredExit";
  }
}
