import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  effectValueRootsForOp,
  type EffectValueRoot
} from "./effect-roots.js";
import type {
  Effect
} from "#backends/wasm/jit/analysis/effects.js";
import type { PathMap } from "#backends/wasm/jit/analysis/paths.js";
import {
  jitExpressionOpIndexesForSourceOp
} from "./expression-uses.js";
import type { PlannedExit } from "./types.js";
import {
  jitExpressionOpEpochs
} from "./value-cache-epochs.js";
import type {
  Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
import {
  collectValueUses,
  type Placement,
  type ValueUse
} from "./value-uses.js";

export type {
  EffectValueRoot,
  EffectValueRootPurpose
} from "./effect-roots.js";

export type EffectPlacement = Placement;

export type PlannedEffect = Readonly<{
  placement: EffectPlacement;
  sourceOpIndex: number;
  valueRoots: readonly EffectValueRoot[];
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
  plannedEffects: readonly PlannedEffect[];
  valueUses: readonly ValueUse[];
}>;

export function planJitEffectsForEmission(
  instructions: readonly JitEffectPlanInstructionInput[],
  effects: readonly Effect<PlannedExit>[]
): JitEffectPlan {
  const effectsMap = groupEffectsMap(effects);
  const plannedEffects: PlannedEffect[] = [];
  let currentEpoch = 0;

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex]!;
    const opEpochs = jitExpressionOpEpochs(instruction, currentEpoch);

    for (let sourceOpIndex = 0; sourceOpIndex < instruction.ir.length; sourceOpIndex += 1) {
      const effect = plannedEffectForSourceOp(
        instruction,
        effectsMap,
        instructionIndex,
        sourceOpIndex,
        opEpochs
      );

      if (effect === undefined) {
        continue;
      }

      plannedEffects.push(effect);
    }

    currentEpoch += logicalWriteEpochCount(instruction);
  }

  return {
    plannedEffects,
    valueUses: collectValueUses({ effects: plannedEffects })
  };
}

function plannedEffectForSourceOp(
  instruction: JitEffectPlanInstructionInput,
  effectsMap: JitEffectsMap,
  instructionIndex: number,
  sourceOpIndex: number,
  opEpochs: readonly number[]
): PlannedEffect | undefined {
  const effect = effectsMap
    .get(instructionIndex)
    ?.get(sourceOpIndex);

  if (effect === undefined) {
    return undefined;
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
      ...effectValueRootsForOp(
        instruction,
        expressionOp,
        effect.kind,
        placement
      )
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
