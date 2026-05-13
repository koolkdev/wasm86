import { ExitReason, type ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { IrOp } from "#x86/ir/model/types.js";
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
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitInstructionState,
  JitMaterializationNeed,
  JitMaterializationPathScope,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";
import { instructionEntry } from "#backends/wasm/jit/codegen/plan/types.js";

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
        recordExitPoint(
          instructionIndex,
          opIndex,
          faultReason,
          entry
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
      recordExitPoint(instructionIndex, opIndex, exitReason, snapshot);
    }
  }

  function recordExitPoint(
    instructionIndex: number,
    opIndex: number,
    exitReason: ExitReasonValue,
    snapshot: JitStateSnapshot
  ): void {
    const stores = snapshot.valueState.exitStores();
    const exitMaterializationIndex = appendExitMaterialization(stores);
    const exitPointIndex = exitPoints.length;

    exitPoints.push({
      instructionIndex,
      opIndex,
      exitReason,
      snapshot,
      exitMaterializationIndex
    });
    appendMaterializationNeeds(
      instructionIndex,
      opIndex,
      exitPointIndex,
      exitReason,
      exitMaterializationIndex,
      exitMaterializationPathScope(exitReason),
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
    exitPointIndex: number,
    exitReason: ExitReasonValue,
    exitMaterializationIndex: number,
    pathScope: JitMaterializationPathScope,
    stores: readonly ExitMaterializationStore[]
  ): void {
    const placement = {
      instructionIndex,
      opIndex,
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

    if (exitPoint?.snapshot.boundary.boundaryIndex === 0) {
      count += 1;
    }
  }

  return count;
}
