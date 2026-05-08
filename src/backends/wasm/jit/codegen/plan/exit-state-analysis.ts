import type { Reg32 } from "#x86/isa/types.js";
import { conditionFlagReadMask } from "#x86/ir/model/flag-effects.js";
import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitIrBlock, JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import { JitBlockStateTracker } from "#backends/wasm/jit/codegen/plan/block-state-tracker.js";
import {
  indexJitEffects,
  type JitEffectIndex,
  jitOpHasPostInstructionExit,
  jitPreInstructionExitReasonAt,
  jitPostInstructionExitReasonsAt
} from "#backends/wasm/jit/ir/effects.js";
import type {
  JitCodegenPlan,
  JitExitPoint,
  JitExitMaterializationPlan,
  JitFlagMaterializationRequirement,
  JitInstructionState,
  JitStateSnapshot
} from "#backends/wasm/jit/codegen/plan/types.js";

export function analyzeJitCodegenState(
  block: JitIrBlock,
  effects: JitEffectIndex = indexJitEffects(block)
): Omit<JitCodegenPlan, "block"> {
  const state = new JitBlockStateTracker();
  const instructionStates: JitInstructionState[] = [];
  const exitPoints: JitExitPoint[] = [];
  const flagMaterializationRequirements: JitFlagMaterializationRequirement[] = [];
  // Non-empty exit materializations stay per-exit because register and flag
  // locals can change before deferred exit blocks are emitted. Empty exits
  // share index 0.
  const exitMaterializations: JitExitMaterializationPlan[] = [{ regs: [], flagMask: 0 }];
  let currentPostState: JitStateSnapshot | undefined;

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];
    currentPostState = undefined;

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while planning JIT codegen: ${instructionIndex}`);
    }

    const entry = state.snapshot("preInstruction", instruction.eip);
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
          preInstructionFaultSnapshot(entry, state.snapshot("preInstruction", instruction.eip))
        );
      }

      recordOpEffects(op, instruction, instructionIndex, opIndex);
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
                exitPointCount: preInstructionExitPointCount,
                preserveCommittedRegs: true
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
    flagMaterializationRequirements,
    exitMaterializations,
    maxExitMaterializationIndex: exitMaterializations.length - 1
  };

  function instructionPostState(instruction: JitIrBlockInstruction): JitStateSnapshot {
    currentPostState ??= state.snapshotPostInstruction(instruction.nextEip);

    return currentPostState;
  }

  function recordOpEffects(
    op: JitIrOp,
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    opIndex: number
  ): void {
    switch (op.op) {
      case "set":
        if (op.role === "registerMaterialization") {
          state.recordCommittedStorageWrite(op.target, instruction.operands);
        } else {
          state.recordStorageWrite(op.target, instruction.operands);
        }
        return;
      case "flags.set":
        state.markSpeculativeFlags(op.writtenMask | op.undefMask);
        return;
      case "flags.boundary":
        state.commitFlags(op.mask);
        return;
      case "aluFlags.condition": {
        const requiredMask = conditionFlagReadMask(op.cc);
        const pendingMask = state.pendingFlags(requiredMask);

        if (requiredMask !== 0) {
          flagMaterializationRequirements.push({
            instructionIndex,
            opIndex,
            reason: "condition",
            requiredMask,
            pendingMask
          });
        }
        return;
      }
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
    const snapshot = instructionPostState(instruction);

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
    const pendingFlagMask = snapshot.speculativeFlags.mask;
    const requiredFlagMask = exitFlagMaterializationMask(snapshot);
    const exitMaterializationIndex = appendExitMaterialization(snapshot.committedRegs, requiredFlagMask);

    exitPoints.push({
      instructionIndex,
      opIndex,
      exitReason,
      snapshot,
      exitMaterializationIndex
    });

    if (requiredFlagMask !== 0) {
      flagMaterializationRequirements.push({
        instructionIndex,
        opIndex,
        reason: "exit",
        requiredMask: requiredFlagMask,
        pendingMask: pendingFlagMask
      });
    }
  }

  function appendExitMaterialization(regs: readonly Reg32[], flagMask: number): number {
    if (regs.length === 0 && flagMask === 0) {
      return 0;
    }

    const index = exitMaterializations.length;

    exitMaterializations.push({
      regs,
      flagMask
    });
    return index;
  }
}

function exitFlagMaterializationMask(snapshot: JitStateSnapshot): number {
  const speculativeMask = snapshot.speculativeFlags.mask;

  return speculativeMask === 0
    ? 0
    : speculativeMask | snapshot.committedFlags.mask;
}

function preInstructionFaultSnapshot(
  entry: JitStateSnapshot,
  current: JitStateSnapshot
): JitStateSnapshot {
  return {
    ...entry,
    committedRegs: current.committedRegs,
    committedFlags: current.committedFlags
  };
}

function countPreInstructionExitPoints(exitPoints: readonly JitExitPoint[], exitStart: number): number {
  let count = 0;

  for (let index = exitStart; index < exitPoints.length; index += 1) {
    const exitPoint = exitPoints[index];

    if (exitPoint?.snapshot.kind === "preInstruction") {
      count += 1;
    }
  }

  return count;
}
