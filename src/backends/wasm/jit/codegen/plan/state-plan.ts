import type { IrOp } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  JitExitStateBuilder
} from "./exit-state.js";
import {
  indexJitEffects,
  type JitEffectIndex,
  jitOpExitsAt
} from "#backends/wasm/jit/ir/effects.js";
import type {
  ExitMaterializationStore,
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitExitStateSnapshot,
  JitInstructionState,
  JitMaterializationNeed
} from "#backends/wasm/jit/codegen/plan/types.js";
import {
  jitExitObservationForOp,
  type JitPlannedObservationPoint
} from "./observations.js";
import { jitMaterializationNeedsForExitStores } from "./materialization.js";
import { buildJitInstructionControlPathScopes } from "./control-paths.js";
import type { JitOpExitKind } from "#backends/wasm/jit/ir/effect-primitives.js";

export function analyzeJitCodegenState(
  block: JitIrBlock,
  effects: JitEffectIndex = indexJitEffects(block)
): Omit<JitCodegenPlan, "block"> {
  const state = new JitExitStateBuilder();
  const instructionStates: JitInstructionState[] = [];
  const exitPoints: JitExitPoint[] = [];
  const materializationNeeds: JitMaterializationNeed[] = [];
  // Non-empty exit materializations stay per-exit because register and flag
  // locals can change before deferred exit blocks are emitted. Empty exits
  // share index 0.
  const exitMaterializations: JitExitMaterializationPlan[] = [{ stores: [] }];

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while planning JIT codegen: ${instructionIndex}`);
    }

    state.beginInstruction();
    const instructionCountDelta = state.instructionCountDelta();
    const initialValueState = state.valueStateSnapshot();
    const controlPathScopes = buildJitInstructionControlPathScopes(
      instruction,
      instructionIndex
    );
    const exitStart = exitPoints.length;

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while planning JIT codegen: ${instructionIndex}:${opIndex}`);
      }

      const exits = jitOpExitsAt(effects, instructionIndex, opIndex);

      recordOpEffects(op, instruction, instructionIndex, opIndex, exits, controlPathScopes);
      state.recordOp(op, instruction, instructionIndex, opIndex);
    }

    instructionStates.push({
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      instructionCountDelta,
      initialValueState,
      controlPathScopes,
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

  function recordOpEffects(
    op: IrOp,
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    opIndex: number,
    exits: readonly JitOpExitKind[],
    controlPathScopes: JitInstructionState["controlPathScopes"]
  ): void {
    recordExitObservations(
      instruction,
      instructionIndex,
      opIndex,
      exits,
      controlPathScopes
    );

    switch (op.op) {
      case "set":
      case "flags.set":
      case "flags.condition":
        return;
      case "next":
        if (exits.length === 0) {
          state.commitInstruction();
        }
        return;
      case "jump":
      case "conditionalJump":
      case "hostTrap":
        return;
      default:
        return;
    }
  }

  function recordExitObservations(
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    opIndex: number,
    exits: readonly JitOpExitKind[],
    controlPathScopes: JitInstructionState["controlPathScopes"]
  ): void {
    if (exits.length === 0) {
      return;
    }

    const observedState = state.exitStateSnapshot();

    for (const exit of exits) {
      const observation = jitExitObservationForOp(
        instruction,
        instructionIndex,
        opIndex,
        exit,
        exitObservedState(exit, observedState),
        controlPathScopes
      );

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
}

function exitObservedState(exit: JitOpExitKind, state: JitExitStateSnapshot): JitExitStateSnapshot {
  switch (exit) {
    case "fallthrough":
    case "jump":
    case "branchTaken":
    case "branchNotTaken":
    case "hostTrap":
      return {
        ...state,
        instructionCountDelta: state.instructionCountDelta + 1
      };
    default:
      return state;
  }
}
