import {
  buildIrExpressionBlockWithSourceMap,
  type IrExpressionOptions
} from "#backends/wasm/codegen/expressions.js";
import type { IrOp } from "#x86/ir/model/types.js";
import type { JitBlock, JitInstruction } from "#backends/wasm/jit/ir/types.js";
import { buildTimeline, type Timeline } from "#backends/wasm/jit/analysis/timeline.js";
import { createJitValueState, type JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import { indexProducedValues } from "#backends/wasm/jit/ir/produced-values.js";
import {
  indexJitEffects,
  jitOpEffectsAt,
  type JitEffectIndex
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
import {
  jitExpressionOpIndexesForSourceOp,
  type JitExpressionUseInstructionInput
} from "./expression-uses.js";
import {
  canInlineJitInstructionGet,
  jitInstructionStorageRefsMayAlias
} from "./operand-analysis.js";

export function analyzeJitCodegenState(
  block: JitBlock,
  effects: JitEffectIndex = indexJitEffects(block)
): Omit<JitCodegenPlan, "block"> {
  const instructionStates: JitInstructionState[] = [];
  const exitPoints: JitExitPoint[] = [];
  const materializationNeeds: JitMaterializationNeed[] = [];
  // Non-empty exit materializations stay per-exit because register and flag
  // locals can change before deferred exit blocks are emitted. Empty exits
  // share index 0.
  const exitMaterializations: JitExitMaterializationPlan[] = [{ stores: [] }];
  let instructionCountDelta = 0;
  let currentValueState = createJitValueState().snapshot();

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while planning JIT codegen: ${instructionIndex}`);
    }

    const initialInstructionCountDelta = instructionCountDelta;
    const initialValueState = currentValueState;
    const expressionPlan = buildIrExpressionBlockWithSourceMap(
      instruction.ir,
      jitExpressionOptions(instruction)
    );
    const valueTimeline = buildTimeline({
      operands: instruction.operands,
      expressions: expressionPlan.expressionBlock,
      entry: initialValueState,
      producedByVar: indexProducedValues(instruction, instructionIndex)
    });
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

      const exits = jitOpEffectsAt(effects, instructionIndex, opIndex).exits;

      recordOpEffects(
        op,
        instruction,
        instructionIndex,
        opIndex,
        exits,
        controlPathScopes,
        {
          expressionBlock: expressionPlan.expressionBlock,
          sourceExpressionMap: expressionPlan.sourceMap
        },
        valueTimeline
      );
    }

    instructionStates.push({
      instructionId: instruction.instructionId,
      eip: instruction.eip,
      nextEip: instruction.nextEip,
      nextMode: instruction.nextMode,
      instructionCountDelta: initialInstructionCountDelta,
      initialValueState,
      controlPathScopes,
      exitPointCount: exitPoints.length - exitStart
    });
    currentValueState = valueTimeline.final;
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
    instruction: JitInstruction,
    instructionIndex: number,
    opIndex: number,
    exits: readonly JitOpExitKind[],
    controlPathScopes: JitInstructionState["controlPathScopes"],
    expressionPlan: JitExpressionUseInstructionInput,
    valueTimeline: Timeline
  ): void {
    recordExitObservations(
      instruction,
      instructionIndex,
      opIndex,
      exits,
      controlPathScopes,
      expressionPlan,
      valueTimeline
    );

    switch (op.op) {
      case "set":
      case "flags.set":
      case "flags.condition":
        return;
      case "next":
        if (exits.length === 0) {
          instructionCountDelta += 1;
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
    instruction: JitInstruction,
    instructionIndex: number,
    opIndex: number,
    exits: readonly JitOpExitKind[],
    controlPathScopes: JitInstructionState["controlPathScopes"],
    expressionPlan: JitExpressionUseInstructionInput,
    valueTimeline: Timeline
  ): void {
    if (exits.length === 0) {
      return;
    }

    const observedState = {
      instructionCountDelta,
      valueState: valueStateBeforeSourceOp(opIndex, expressionPlan, valueTimeline)
    };

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

function valueStateBeforeSourceOp(
  sourceOpIndex: number,
  expressionPlan: JitExpressionUseInstructionInput,
  valueTimeline: Timeline
): JitValueStateSnapshot {
  const expressionOpIndexes = jitExpressionOpIndexesForSourceOp(expressionPlan, sourceOpIndex);

  if (expressionOpIndexes.length !== 1) {
    throw new Error(
      `expected one JIT expression op for source state ${sourceOpIndex}, got ${expressionOpIndexes.length}`
    );
  }

  const snapshot = valueTimeline.snapshots[expressionOpIndexes[0]!];

  if (snapshot === undefined) {
    throw new Error(`missing JIT value-state timeline snapshot for source op ${sourceOpIndex}`);
  }

  return snapshot;
}

function jitExpressionOptions(instruction: Pick<JitInstruction, "operands">): IrExpressionOptions {
  return {
    canInlineGet: (source) => canInlineJitInstructionGet(instruction, source),
    alias: {
      storageMayAlias: (write, read) => jitInstructionStorageRefsMayAlias(instruction, write, read)
    }
  };
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
