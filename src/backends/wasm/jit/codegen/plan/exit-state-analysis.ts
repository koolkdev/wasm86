import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import { u32 } from "#x86/state/cpu-state.js";
import type { IrOp, TargetRef } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { JitBlockStateTracker } from "#backends/wasm/jit/codegen/plan/block-state-tracker.js";
import {
  indexJitEffects,
  type JitEffectIndex,
  jitOpHasPostInstructionExit,
  jitPreInstructionExitReasonAt,
  jitPostInstructionExitReasonsAt
} from "#backends/wasm/jit/ir/effects.js";
import type {
  ExitMaterializationStore,
  JitBoundaryRef,
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitInstructionState,
  JitMaterializationNeed,
  JitMaterializationPathScope,
  JitObservationPayload,
  JitObservationValue,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  beforeOp,
  instructionEntry
} from "#backends/wasm/jit/codegen/plan/types.js";

export function analyzeJitCodegenState(
  block: JitIrBlock,
  effects: JitEffectIndex = indexJitEffects(block)
): Omit<JitCodegenPlan, "block"> {
  const state = new JitBlockStateTracker();
  const instructionStates: JitInstructionState[] = [];
  const exitPoints: JitExitPoint[] = [];
  const materializationNeeds: JitMaterializationNeed[] = [];
  // Non-empty exit materializations stay per-exit because register and flag
  // locals can change before deferred exit blocks are emitted. Empty exits
  // share index 0.
  const exitMaterializations: JitExitMaterializationPlan[] = [{ stores: [] }];
  let currentPostState: JitStateSnapshot | undefined;

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];
    currentPostState = undefined;

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while planning JIT codegen: ${instructionIndex}`);
    }

    state.beginInstruction();
    const entry = state.snapshot(instructionEntry(instructionIndex));
    const exitStart = exitPoints.length;

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while planning JIT codegen: ${instructionIndex}:${opIndex}`);
      }

      const faultReason = jitPreInstructionExitReasonAt(effects, instructionIndex, opIndex);

      if (faultReason !== undefined) {
        recordObservationPoint(
          instructionIndex,
          opIndex,
          beforeOp(instructionIndex, opIndex),
          faultReason,
          entry,
          {
            kind: "static",
            value: instruction.eip
          },
          {
            kind: "runtime",
            source: "memoryAddress"
          }
        );
      }

      recordOpEffects(op, instruction, instructionIndex, opIndex);
      state.recordOp(op, instruction, instructionIndex, opIndex);
    }

    if (currentPostState === undefined) {
      throw new Error(`missing JIT instruction terminator while planning JIT codegen: ${instructionIndex}`);
    }

    const preInstructionExitPointCount = countPreInstructionExitPoints(exitPoints, exitStart);

    instructionStates.push({
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      entryPoint: {
        instructionIndex,
        snapshot: entry,
        ...(preInstructionExitPointCount === 0
          ? {}
          : {
              preInstructionExitPlan: {
                exitPointCount: preInstructionExitPointCount
              }
            })
      },
      postInstructionState: currentPostState,
      exitPointCount: exitPoints.length - exitStart
    });
  }

  return {
    instructionStates,
    exitPoints,
    materializationNeeds,
    exitMaterializations,
    maxExitMaterializationIndex: exitMaterializations.length - 1
  };

  function instructionPostState(
    instruction: JitIrBlockInstruction,
    instructionIndex: number
  ): JitStateSnapshot {
    currentPostState ??= state.snapshotPostInstruction(instructionIndex, instruction);

    return currentPostState;
  }

  function recordOpEffects(
    op: IrOp,
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    opIndex: number
  ): void {
    switch (op.op) {
      case "set":
        return;
      case "flags.set":
        return;
      case "flags.condition":
        return;
      case "next":
        recordPostInstructionExits(instruction, instructionIndex, opIndex);

        if (!jitOpHasPostInstructionExit(effects, instructionIndex, opIndex)) {
          state.commitInstruction();
        }
        return;
      case "jump":
      case "conditionalJump":
      case "hostTrap":
        recordPostInstructionExits(instruction, instructionIndex, opIndex);
        return;
      default:
        return;
    }
  }

  function recordPostInstructionExits(
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    opIndex: number
  ): void {
    const exitReasons = jitPostInstructionExitReasonsAt(effects, instructionIndex, opIndex);
    const snapshot = instructionPostState(instruction, instructionIndex);

    for (const exitReason of exitReasons) {
      recordObservationPoint(
        instructionIndex,
        opIndex,
        beforeOp(instructionIndex, opIndex),
        exitReason,
        snapshot,
        visibleEipForPostInstructionExit(instruction, exitReason, opIndex),
        payloadForPostInstructionExit(instruction, exitReason, opIndex)
      );
    }
  }

  function recordObservationPoint(
    instructionIndex: number,
    opIndex: number,
    emitBoundary: JitBoundaryRef,
    exitReason: ExitReasonValue,
    observedState: JitStateSnapshot,
    visibleEip: JitObservationValue,
    payload: JitObservationPayload
  ): void {
    const stores = observedState.valueState.exitStores();
    const exitMaterializationIndex = appendExitMaterialization(stores);
    const exitPointIndex = exitPoints.length;
    const pathScope = exitMaterializationPathScope(exitReason);

    exitPoints.push({
      instructionIndex,
      opIndex,
      emitBoundary,
      observedBoundary: observedState.boundary,
      observedState,
      visibleEip,
      exitReason,
      payload,
      pathScope,
      snapshot: observedState,
      exitMaterializationIndex
    });
    appendMaterializationNeeds(
      instructionIndex,
      opIndex,
      emitBoundary,
      observedState.boundary,
      exitPointIndex,
      exitReason,
      exitMaterializationIndex,
      pathScope,
      stores
    );
  }

  function appendExitMaterialization(stores: readonly ExitMaterializationStore[]): number {
    if (stores.length === 0) {
      return 0;
    }

    const index = exitMaterializations.length;

    exitMaterializations.push({
      stores
    });
    return index;
  }

  function appendMaterializationNeeds(
    instructionIndex: number,
    opIndex: number,
    emitBoundary: JitBoundaryRef,
    observedBoundary: JitBoundaryRef,
    exitPointIndex: number,
    exitReason: ExitReasonValue,
    exitMaterializationIndex: number,
    pathScope: JitMaterializationPathScope,
    stores: readonly ExitMaterializationStore[]
  ): void {
    const placement = {
      instructionIndex,
      opIndex,
      emitBoundary,
      observedBoundary,
      observationIndex: exitPointIndex,
      exitPointIndex,
      exitReason,
      exitMaterializationIndex
    };

    for (const store of stores) {
      materializationNeeds.push({
        consumer: store.target.kind === "aluFlags" ? "flagExitStore" : "registerExitStore",
        target: store.target,
        value: store.value,
        placement,
        pathScope
      });
    }
  }
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

function countPreInstructionExitPoints(exitPoints: readonly JitExitPoint[], exitStart: number): number {
  let count = 0;

  for (let index = exitStart; index < exitPoints.length; index += 1) {
    const exitPoint = exitPoints[index];

    if (exitPoint?.observedBoundary.boundaryIndex === 0) {
      count += 1;
    }
  }

  return count;
}
