import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  jitOpEffectsAt,
  type JitEffectIndex
} from "#backends/wasm/jit/ir/effects.js";
import type {
  JitOpExitKind,
  JitOrderedEffectKind
} from "#backends/wasm/jit/ir/effect-primitives.js";
import {
  jitEffectValueRootForMaterializationNeed,
  jitEffectValueRootsForOp,
  type JitEffectValueRoot
} from "./effect-roots.js";
import type {
  JitControlPathScopesMap
} from "./control-paths.js";
import {
  jitExpressionOpIndexesForSourceOp
} from "./expression-uses.js";
import type { JitMaterializationNeed } from "./types.js";
import {
  jitExpressionOpEpochs
} from "./value-cache-epochs.js";
import type {
  JitInstructionValueTimeline
} from "./value-timeline.js";
import {
  plannedValueUsesForRoots,
  type JitPlannedValueUse,
  type JitValueUsePlacement
} from "./value-uses.js";

export type {
  JitEffectValueRoot,
  JitEffectValueRootPurpose
} from "./effect-roots.js";

export type JitEffectPlacement = JitValueUsePlacement;

export type JitPlannedEffect = Readonly<{
  placement: JitEffectPlacement;
  sourceOpIndex: number;
  kind: JitOrderedEffectKind;
  exits: readonly JitOpExitKind[];
  valueRoots: readonly JitEffectValueRoot[];
}>;

export type JitEffectPlanInstructionInput = Readonly<{
  ir: JitInstruction["ir"];
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  expressionPathScopes: JitControlPathScopesMap;
  valueTimeline: JitInstructionValueTimeline;
}>;

export type JitEffectPlan = Readonly<{
  plannedEffects: readonly JitPlannedEffect[];
  plannedValueUses: readonly JitPlannedValueUse[];
}>;

export function planJitEffectsForEmission(
  instructions: readonly JitEffectPlanInstructionInput[],
  effects: JitEffectIndex,
  materializationNeeds: readonly JitMaterializationNeed[]
): JitEffectPlan {
  const materializationNeedsBySourceOp = groupMaterializationNeeds(materializationNeeds);
  const plannedEffects: JitPlannedEffect[] = [];
  const plannedValueUses: JitPlannedValueUse[] = [];
  let currentEpoch = 0;

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex]!;
    const opEpochs = jitExpressionOpEpochs(instruction, currentEpoch);

    for (let sourceOpIndex = 0; sourceOpIndex < instruction.ir.length; sourceOpIndex += 1) {
      const effect = plannedEffectForSourceOp(
        instruction,
        effects,
        materializationNeedsBySourceOp,
        instructionIndex,
        sourceOpIndex,
        opEpochs
      );

      if (effect === undefined) {
        continue;
      }

      plannedEffects.push(effect);
      plannedValueUses.push(...plannedValueUsesForRoots(
        instruction,
        effect.valueRoots,
        effect.placement
      ));
    }

    currentEpoch += logicalWriteEpochCount(instruction);
  }

  return {
    plannedEffects,
    plannedValueUses
  };
}

function plannedEffectForSourceOp(
  instruction: JitEffectPlanInstructionInput,
  effects: JitEffectIndex,
  materializationNeedsBySourceOp: JitMaterializationNeedsBySourceOp,
  instructionIndex: number,
  sourceOpIndex: number,
  opEpochs: readonly number[]
): JitPlannedEffect | undefined {
  const opEffects = jitOpEffectsAt(effects, instructionIndex, sourceOpIndex);
  const materializationRoots = materializationNeedsBySourceOp
    .get(instructionIndex)
    ?.get(sourceOpIndex) ?? [];

  if (opEffects.orderedEffectKind === undefined && materializationRoots.length === 0) {
    return undefined;
  }

  if (opEffects.orderedEffectKind === undefined) {
    throw new Error(
      `JIT materialization need is attached to a non-effect op: ${instructionIndex}:${sourceOpIndex}`
    );
  }

  const expressionOpIndex = expressionOpIndexForSourceEffect(
    instruction,
    sourceOpIndex
  );
  const expressionOp = instruction.expressionBlock[expressionOpIndex]!;
  const placement = {
    instructionIndex,
    opIndex: expressionOpIndex,
    epoch: opEpochs[expressionOpIndex]!
  };

  return {
    placement,
    sourceOpIndex,
    kind: opEffects.orderedEffectKind,
    exits: opEffects.exits,
    valueRoots: [
      ...jitEffectValueRootsForOp(
        instruction,
        expressionOp,
        opEffects.orderedEffectKind,
        placement
      ),
      ...materializationRoots.map(jitEffectValueRootForMaterializationNeed)
    ]
  };
}

function expressionOpIndexForSourceEffect(
  instruction: JitEffectPlanInstructionInput,
  sourceOpIndex: number
): number {
  const expressionOpIndexes = jitExpressionOpIndexesForSourceOp(instruction, sourceOpIndex);

  if (expressionOpIndexes.length !== 1) {
    throw new Error(
      `expected one JIT expression op for source effect ${sourceOpIndex}, got ${expressionOpIndexes.length}`
    );
  }

  return expressionOpIndexes[0]!;
}

function logicalWriteEpochCount(instruction: JitEffectPlanInstructionInput): number {
  return new Set(
    instruction.valueTimeline.logicalWrites.map((write) => write.expressionOpIndex)
  ).size;
}

type JitMaterializationNeedsBySourceOp = ReadonlyMap<
  number,
  ReadonlyMap<number, readonly JitMaterializationNeed[]>
>;

function groupMaterializationNeeds(
  needs: readonly JitMaterializationNeed[]
): JitMaterializationNeedsBySourceOp {
  const byInstruction = new Map<number, Map<number, JitMaterializationNeed[]>>();

  for (const need of needs) {
    const byOp = byInstruction.get(need.placement.instructionIndex) ?? new Map();
    const opNeeds = byOp.get(need.placement.opIndex) ?? [];

    byOp.set(need.placement.opIndex, [...opNeeds, need]);
    byInstruction.set(need.placement.instructionIndex, byOp);
  }

  return byInstruction;
}
