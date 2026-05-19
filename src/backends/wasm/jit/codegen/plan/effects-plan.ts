import type { EffectInfo } from "#backends/wasm/jit/analysis/effects.js";
import type { JitProducedValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  jitExpressionOpIndexesForSourceOp
} from "./expression-uses.js";
import {
  jitExpressionOpEpochs
} from "./epochs.js";
import type {
  PlannedExit,
  PlannedInstruction
} from "./types.js";
import type {
  Effect,
  EffectsPlan,
  Placement,
} from "./effect-types.js";

export function planEffects(instructions: readonly PlannedInstruction[]): EffectsPlan {
  const effects: Effect[] = [];
  let currentEpoch = 0;

  for (const instruction of instructions) {
    const opEpochs = jitExpressionOpEpochs({
      expressionBlock: instruction.analysis.expressions.block,
      valueTimeline: instruction.analysis.timeline
    }, currentEpoch);

    for (const effect of instruction.flow.effects) {
      effects.push(planEffect(effect, instruction, opEpochs));
    }

    currentEpoch += logicalWriteEpochCount(instruction);
  }

  return effects;
}

function planEffect(
  effectInfo: EffectInfo<PlannedExit>,
  instruction: PlannedInstruction,
  opEpochs: readonly number[]
): Effect {
  const at = effectPlacement(instruction, effectInfo, opEpochs);
  const sourceOp = entryAt(instruction.analysis.instruction.ir, effectInfo.at.opIndex);
  const expressionOp = entryAt(instruction.analysis.expressions.block, at.opIndex);
  const view = instruction.analysis.timeline.viewAt(at.opIndex);

  switch (effectInfo.kind) {
    case "memoryGuard": {
      if (sourceOp.op !== "memory.guard" || expressionOp.op !== "memory.guard") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      return {
        kind: effectInfo.kind,
        at,
        address: view.value(expressionOp.address),
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
        address: view.storageAddress(expressionOp.target),
        value: view.value(expressionOp.value),
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
        address: view.storageAddress(expressionOp.value.source),
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
        target: view.value(expressionOp.target),
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
        condition: view.value(expressionOp.condition),
        takenTarget: view.value(expressionOp.taken),
        notTakenTarget: view.value(expressionOp.notTaken),
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
        vector: view.value(expressionOp.vector),
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
  instruction: PlannedInstruction,
  effectInfo: EffectInfo<PlannedExit>,
  opEpochs: readonly number[]
): Placement {
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

function expressionOpIndexForSourceEffect(
  instruction: PlannedInstruction,
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

function logicalWriteEpochCount(instruction: PlannedInstruction): number {
  return new Set(
    instruction.analysis.timeline.writes.map((write) => write.opIndex)
  ).size;
}

function entryAt<T>(
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
  instruction: PlannedInstruction,
  opIndex: number,
  refId: number
): JitProducedValue {
  const produced = instruction.analysis.timeline.produced.find((definition) =>
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
