import type { IrOp } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { JitBoundaryStateBuilder } from "./boundaries.js";
import {
  indexJitEffects,
  type JitEffectIndex,
  jitOpHasPostInstructionExit
} from "#backends/wasm/jit/ir/effects.js";
import type {
  ExitMaterializationStore,
  JitBoundaryState,
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitInstructionState,
  JitMaterializationNeed
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  instructionEntry
} from "./boundaries.js";
import {
  countInstructionEntryObservations,
  jitPostInstructionObservationsForOp,
  jitPreInstructionObservationForOp,
  type JitPlannedObservationPoint
} from "./observations.js";
import { jitMaterializationNeedsForExitStores } from "./materialization.js";

export function analyzeJitCodegenState(
  block: JitIrBlock,
  effects: JitEffectIndex = indexJitEffects(block)
): Omit<JitCodegenPlan, "block"> {
  const state = new JitBoundaryStateBuilder();
  const instructionStates: JitInstructionState[] = [];
  const boundaryStates: JitBoundaryState[] = [];
  const exitPoints: JitExitPoint[] = [];
  const materializationNeeds: JitMaterializationNeed[] = [];
  // Non-empty exit materializations stay per-exit because register and flag
  // locals can change before deferred exit blocks are emitted. Empty exits
  // share index 0.
  const exitMaterializations: JitExitMaterializationPlan[] = [{ stores: [] }];
  let currentPostState: JitBoundaryState | undefined;

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];
    currentPostState = undefined;

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while planning JIT codegen: ${instructionIndex}`);
    }

    state.beginInstruction();
    const entryState = state.boundaryState(instructionEntry(instructionIndex));
    const exitStart = exitPoints.length;

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while planning JIT codegen: ${instructionIndex}:${opIndex}`);
      }

      const preObservation = jitPreInstructionObservationForOp(
        effects,
        instruction,
        instructionIndex,
        opIndex,
        entryState
      );

      if (preObservation !== undefined) {
        recordObservationPoint(preObservation);
      }

      recordOpEffects(op, instruction, instructionIndex, opIndex);
      state.recordOp(op, instruction, instructionIndex, opIndex);
    }

    if (currentPostState === undefined) {
      throw new Error(`missing JIT instruction terminator while planning JIT codegen: ${instructionIndex}`);
    }

    const preInstructionExitPointCount = countInstructionEntryObservations(exitPoints, exitStart);

    instructionStates.push({
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      entryPoint: {
        instructionIndex,
        boundaryState: entryState,
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
    boundaryStates,
    exitPoints,
    materializationNeeds,
    exitMaterializations,
    maxExitMaterializationIndex: exitMaterializations.length - 1
  };

  function instructionPostState(
    instruction: JitIrBlockInstruction,
    instructionIndex: number
  ): JitBoundaryState {
    currentPostState ??= state.postInstructionBoundaryState(instructionIndex, instruction);

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
      case "flags.set":
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
    const snapshot = instructionPostState(instruction, instructionIndex);

    for (const observation of jitPostInstructionObservationsForOp(
      effects,
      instruction,
      instructionIndex,
      opIndex,
      snapshot
    )) {
      recordObservationPoint(observation);
    }
  }

  function recordObservationPoint(observation: JitPlannedObservationPoint): void {
    const stores = observation.observedState.valueState.exitStores();
    const exitMaterializationIndex = appendExitMaterialization(stores);
    const exitPointIndex = exitPoints.length;
    const exitPoint: JitExitPoint = {
      ...observation,
      exitMaterializationIndex
    };

    appendObservedBoundaryState(observation.observedState);
    exitPoints.push(exitPoint);
    materializationNeeds.push(...jitMaterializationNeedsForExitStores(
      exitPoint,
      exitPointIndex,
      stores
    ));
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

  function appendObservedBoundaryState(boundaryState: JitBoundaryState): void {
    if (boundaryStates.some((entry) => boundaryRefsEqual(entry.boundary, boundaryState.boundary))) {
      return;
    }

    boundaryStates.push(boundaryState);
  }
}

function boundaryRefsEqual(
  left: JitBoundaryState["boundary"],
  right: JitBoundaryState["boundary"]
): boolean {
  return left.instructionIndex === right.instructionIndex &&
    left.boundaryIndex === right.boundaryIndex;
}
