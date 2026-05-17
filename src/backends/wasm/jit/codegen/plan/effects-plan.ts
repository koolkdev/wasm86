import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { EffectInfo } from "#backends/wasm/jit/analysis/effects.js";
import type { InstructionAnalysis } from "#backends/wasm/jit/analysis/effects.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import type { JitProducedValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  opView,
  requireStorageAddress,
  requireValueExpr
} from "#backends/wasm/jit/analysis/timeline.js";
import {
  jitExpressionOpIndexesForSourceOp
} from "./expression-uses.js";
import {
  jitExpressionOpEpochs
} from "./epochs.js";
import type { PlannedExit } from "./types.js";
import type {
  Effect,
  EffectPlacement,
  EffectsPlan
} from "./effect-types.js";

type EffectsPlanInstruction = Pick<
  InstructionAnalysis,
  "valueTimeline"
> & Readonly<{
  ir: JitInstruction["ir"];
  nextEip: number;
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
}>;

type PlanEffectsInput = Readonly<{
  effects: readonly EffectInfo<PlannedExit>[];
  instructions: readonly EffectsPlanInstruction[];
}>;

export function planEffects(input: PlanEffectsInput): EffectsPlan {
  const epochsByInstruction = effectEpochsByInstruction(input.instructions);

  return input.effects.map((effect) =>
    planEffect(
      effect,
      requiredAt(input.instructions, effect.at.instructionIndex),
      requiredAt(epochsByInstruction, effect.at.instructionIndex)
    )
  );
}

function planEffect(
  effectInfo: EffectInfo<PlannedExit>,
  instruction: EffectsPlanInstruction,
  opEpochs: readonly number[]
): Effect {
  const at = effectPlacement(instruction, effectInfo, opEpochs);
  const sourceOp = requiredAt(instruction.ir, effectInfo.at.opIndex);
  const expressionOp = requiredAt(instruction.expressionBlock, at.opIndex);
  const view = opView(instruction.valueTimeline, at.opIndex);
  const valueOptions = { nextEip: instruction.nextEip };

  switch (effectInfo.kind) {
    case "memoryGuard": {
      if (sourceOp.op !== "memory.guard" || expressionOp.op !== "memory.guard") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      return {
        kind: effectInfo.kind,
        at,
        address: requireValueExpr(view, expressionOp.address, valueOptions),
        byteLength: expressionOp.byteLength,
        access: expressionOp.access,
        exit: effectInfo.faultExit
      };
    }
    case "memoryStore": {
      if (sourceOp.op !== "set" || expressionOp.op !== "set") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      return {
        kind: effectInfo.kind,
        at,
        address: requireStorageAddress(view, expressionOp.target, valueOptions),
        value: requireValueExpr(view, expressionOp.value, valueOptions),
        width: expressionOp.accessWidth
      };
    }
    case "memoryLoad": {
      if (sourceOp.op !== "get" || expressionOp.op !== "let32") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      if (expressionOp.value.kind !== "source") {
        throw new Error(`JIT produced value effect mapped to ${expressionOp.value.kind}`);
      }

      return {
        kind: effectInfo.kind,
        at,
        result: producedValue(instruction, at.opIndex, expressionOp.dst.id),
        address: requireStorageAddress(view, expressionOp.value.source, valueOptions),
        width: expressionOp.value.accessWidth,
        signed: expressionOp.value.signed === true
      };
    }
    case "jump": {
      if (sourceOp.op !== "jump" || expressionOp.op !== "jump") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      return {
        kind: effectInfo.kind,
        at,
        target: requireValueExpr(view, expressionOp.target, valueOptions),
        exit: effectInfo.exit
      };
    }
    case "branch": {
      if (sourceOp.op !== "conditionalJump" || expressionOp.op !== "conditionalJump") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      assertDistinctBranchExits(effectInfo);

      return {
        kind: effectInfo.kind,
        at,
        condition: requireValueExpr(view, expressionOp.condition, valueOptions),
        takenTarget: requireValueExpr(view, expressionOp.taken, valueOptions),
        notTakenTarget: requireValueExpr(view, expressionOp.notTaken, valueOptions),
        taken: effectInfo.taken,
        notTaken: effectInfo.notTaken
      };
    }
    case "hostTrap": {
      if (sourceOp.op !== "hostTrap" || expressionOp.op !== "hostTrap") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      return {
        kind: effectInfo.kind,
        at,
        vector: requireValueExpr(view, expressionOp.vector, valueOptions),
        exit: effectInfo.exit
      };
    }
    case "fallthrough": {
      if (sourceOp.op !== "next" || expressionOp.op !== "next") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      return {
        kind: effectInfo.kind,
        at,
        exit: effectInfo.exit
      };
    }
  }
}

function effectPlacement(
  instruction: EffectsPlanInstruction,
  effectInfo: EffectInfo<PlannedExit>,
  opEpochs: readonly number[]
): EffectPlacement {
  const expressionOpIndex = expressionOpIndexForSourceEffect(
    instruction,
    effectInfo.at.opIndex
  );
  const epoch = opEpochs[expressionOpIndex];

  if (epoch === undefined) {
    throw new Error(`missing JIT effect epoch for expression op ${expressionOpIndex}`);
  }

  return {
    instructionIndex: effectInfo.at.instructionIndex,
    opIndex: expressionOpIndex,
    epoch
  };
}

function effectEpochsByInstruction(
  instructions: readonly EffectsPlanInstruction[]
): readonly (readonly number[])[] {
  const epochs: (readonly number[])[] = [];
  let currentEpoch = 0;

  for (const instruction of instructions) {
    epochs.push(jitExpressionOpEpochs(instruction, currentEpoch));
    currentEpoch += logicalWriteEpochCount(instruction);
  }

  return epochs;
}

function expressionOpIndexForSourceEffect(
  instruction: EffectsPlanInstruction,
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

function logicalWriteEpochCount(instruction: EffectsPlanInstruction): number {
  return new Set(
    instruction.valueTimeline.writes.map((write) => write.opIndex)
  ).size;
}

function requiredAt<T>(
  entries: readonly T[],
  index: number
): T {
  const entry = entries[index];

  if (entry === undefined) {
    throw new Error(`missing JIT effects plan entry: ${index}`);
  }

  return entry;
}

function producedValue(
  instruction: EffectsPlanInstruction,
  opIndex: number,
  refId: number
): JitProducedValue {
  const produced = instruction.valueTimeline.produced.find((definition) =>
    definition.opIndex === opIndex &&
      definition.ref.kind === "var" &&
      definition.ref.id === refId
  )?.value;

  if (produced === undefined) {
    throw new Error(`JIT produced value is not available at expression op ${opIndex}`);
  }

  return produced;
}

function assertDistinctBranchExits(
  effectInfo: Extract<EffectInfo<PlannedExit>, { kind: "branch" }>
): void {
  if (effectInfo.taken.id === effectInfo.notTaken.id) {
    throw new Error(`JIT branch effect has duplicate exits: ${effectInfo.taken.id}`);
  }
}

function unexpectedEffectOp(
  effectInfo: EffectInfo<PlannedExit>,
  op: string
): never {
  throw new Error(`JIT effect ${effectInfo.kind} mapped to expression op ${op}`);
}
