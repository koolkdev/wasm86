import type { EffectInfo } from "#backends/wasm/jit/analysis/effects.js";
import type { JitLoadResultValue } from "#backends/wasm/jit/ir/values/types.js";
import type { BlockAnalysis } from "#backends/wasm/jit/analysis/block.js";
import {
  preparedOpsFromBlockExpressions,
  type BlockExpressions
} from "#backends/wasm/jit/ir/block-expressions.js";
import {
  jitExpressionOpEpochs
} from "./epochs.js";
import type {
  JitCodegenPlan,
  PlannedExit
} from "./types.js";
import type {
  Effect,
  EffectsPlan,
  Placement,
} from "./effect-types.js";

export function planEffects(plan: JitCodegenPlan): EffectsPlan {
  const opEpochs = jitExpressionOpEpochs({
    expressionBlock: preparedOpsFromBlockExpressions(plan.analysis.expressions),
    valueTimeline: plan.analysis.timeline
  });
  const effects: Effect[] = [];

  for (const effect of plan.effects) {
    effects.push(planEffect(effect, plan.analysis, opEpochs));
  }

  return effects;
}

function planEffect(
  effectInfo: EffectInfo<PlannedExit>,
  analysis: BlockAnalysis,
  opEpochs: readonly number[]
): Effect {
  const at = effectPlacement(effectInfo, opEpochs);
  const expressionOp = expressionOpAt(analysis.expressions, at.opIndex);
  const view = analysis.timeline.viewAt(at.opIndex);

  switch (effectInfo.kind) {
    case "memoryGuard": {
      if (expressionOp.op !== "memory.guard") {
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
      if (expressionOp.op !== "set") {
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
      if (expressionOp.op !== "let32") {
        return unexpectedEffectOp(effectInfo, expressionOp.op);
      }

      if (expressionOp.value.kind !== "source") {
        throw new Error(`JIT load-result value effect mapped to ${expressionOp.value.kind}`);
      }

      return {
        kind: effectInfo.kind,
        at,
        result: loadResultValue(analysis, at.opIndex, expressionOp.dst.id),
        address: view.storageAddress(expressionOp.value.source),
        width: expressionOp.value.accessWidth,
        signed: expressionOp.value.signed === true
      };
    }
    case "jump": {
      if (expressionOp.op !== "jump") {
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
      if (expressionOp.op !== "conditionalJump") {
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
      if (expressionOp.op !== "hostTrap") {
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
      if (expressionOp.op !== "next") {
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
  effectInfo: EffectInfo<PlannedExit>,
  opEpochs: readonly number[]
): Placement {
  const epoch = opEpochs[effectInfo.at.opIndex];

  if (epoch === undefined) {
    throw new Error(`missing JIT effect epoch for expression op ${effectInfo.at.opIndex}`);
  }

  return {
    opIndex: effectInfo.at.opIndex,
    epoch
  };
}

function expressionOpAt(
  expressions: BlockExpressions,
  index: number
) {
  const entry = expressions.ops[index];

  if (entry === undefined) {
    throw new Error(`missing JIT effects plan entry: ${index}`);
  }

  if (entry.opIndex !== index) {
    throw new Error(`JIT effects plan op index mismatch: ${entry.opIndex} !== ${index}`);
  }

  return entry.op;
}

function loadResultValue(
  analysis: BlockAnalysis,
  opIndex: number,
  refId: number
): JitLoadResultValue {
  const loadResult = analysis.timeline.loadResults.find((definition) =>
    definition.opIndex === opIndex &&
      definition.ref.kind === "var" &&
      definition.ref.id === refId
  )?.value;

  if (loadResult === undefined) {
    throw new Error(`JIT load-result value is not available at expression op ${opIndex}`);
  }

  return loadResult;
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
