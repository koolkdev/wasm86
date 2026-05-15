import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  jitEffectValueRootForMaterializationNeed,
  jitEffectValueRootsForOp,
  type JitEffectValueRoot
} from "./effect-roots.js";
import type {
  Effect
} from "#backends/wasm/jit/analysis/effects.js";
import type { PathMap } from "#backends/wasm/jit/analysis/paths.js";
import {
  jitExpressionOpIndexesForSourceOp
} from "./expression-uses.js";
import type { JitMaterializationNeed, PlannedExit } from "./types.js";
import {
  jitExpressionOpEpochs
} from "./value-cache-epochs.js";
import type {
  Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
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
  valueRoots: readonly JitEffectValueRoot[];
}> & (
  | Readonly<{ kind: "memoryGuard"; faultExit: PlannedExit }>
  | Readonly<{ kind: "memoryStore" }>
  | Readonly<{ kind: "producedValue" }>
  | Readonly<{ kind: "jump"; exit: PlannedExit }>
  | Readonly<{ kind: "branch"; taken: PlannedExit; notTaken: PlannedExit }>
  | Readonly<{ kind: "hostTrap"; exit: PlannedExit }>
  | Readonly<{ kind: "fallthrough"; exit: PlannedExit }>
);

export type JitEffectPlanInstructionInput = Readonly<{
  ir: JitInstruction["ir"];
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
  expressionPaths: PathMap;
  valueTimeline: Timeline;
}>;

export type JitEffectPlan = Readonly<{
  plannedEffects: readonly JitPlannedEffect[];
  plannedValueUses: readonly JitPlannedValueUse[];
}>;

export function planJitEffectsForEmission(
  instructions: readonly JitEffectPlanInstructionInput[],
  effects: readonly Effect<PlannedExit>[],
  materializationNeeds: readonly JitMaterializationNeed[]
): JitEffectPlan {
  const effectsMap = groupEffectsMap(effects);
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
        effectsMap,
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
  effectsMap: JitEffectsMap,
  materializationNeedsBySourceOp: JitMaterializationNeedsBySourceOp,
  instructionIndex: number,
  sourceOpIndex: number,
  opEpochs: readonly number[]
): JitPlannedEffect | undefined {
  const effect = effectsMap
    .get(instructionIndex)
    ?.get(sourceOpIndex);
  const materializationRoots = materializationNeedsBySourceOp
    .get(instructionIndex)
    ?.get(sourceOpIndex) ?? [];

  if (effect === undefined && materializationRoots.length === 0) {
    return undefined;
  }

  if (effect === undefined) {
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
    ...effect,
    placement,
    sourceOpIndex,
    valueRoots: [
      ...jitEffectValueRootsForOp(
        instruction,
        expressionOp,
        effect.kind,
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
    instruction.valueTimeline.writes.map((write) => write.opIndex)
  ).size;
}

type JitMaterializationNeedsBySourceOp = ReadonlyMap<
  number,
  ReadonlyMap<number, readonly JitMaterializationNeed[]>
>;

type JitEffectsMap = ReadonlyMap<
  number,
  ReadonlyMap<number, Effect<PlannedExit>>
>;

function groupEffectsMap(
  effects: readonly Effect<PlannedExit>[]
): JitEffectsMap {
  const byInstruction = new Map<number, Map<number, Effect<PlannedExit>>>();

  for (const effect of effects) {
    const byOp = byInstruction.get(effect.at.instructionIndex) ?? new Map();

    if (byOp.has(effect.at.opIndex)) {
      throw new Error(
        `multiple JIT effects for source op: ${effect.at.instructionIndex}:${effect.at.opIndex}`
      );
    }

    byOp.set(effect.at.opIndex, effect);
    byInstruction.set(effect.at.instructionIndex, byOp);
  }

  return byInstruction;
}

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
