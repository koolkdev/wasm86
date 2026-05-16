import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import type { EffectKind } from "#backends/wasm/jit/analysis/effect-classifier.js";
import {
  branchPath,
  type BranchPaths,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import type { Timeline } from "#backends/wasm/jit/analysis/timeline.js";
import { effectValueRootsForOp } from "#backends/wasm/jit/codegen/plan/effect-roots.js";
import { jitExpressionOpEpochs } from "#backends/wasm/jit/codegen/plan/epochs.js";
import {
  expandRootUse,
  type ValueRoot,
  type ValueUse
} from "#backends/wasm/jit/codegen/plan/value-uses.js";
import { rootExpressionPaths } from "./path-test-helpers.js";

export type TestValueRoot = Omit<ValueRoot, "at">;

export function valueUsesForExpressionBlock(input: Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: Timeline;
  expressionPaths?: PathMap;
  extraUses?: ReadonlyMap<number, readonly TestValueRoot[]>;
  instructionIndex?: number;
  startEpoch?: number;
}>): readonly ValueUse[] {
  const expressionPaths = input.expressionPaths ?? rootExpressionPaths(input.expressionBlock);
  const instructionIndex = input.instructionIndex ?? 0;
  const opEpochs = jitExpressionOpEpochs({
    expressionBlock: input.expressionBlock,
    valueTimeline: input.valueTimeline
  }, input.startEpoch ?? 0);
  const roots: ValueRoot[] = [];

  for (let opIndex = 0; opIndex < input.expressionBlock.length; opIndex += 1) {
    const op = input.expressionBlock[opIndex];

    if (op === undefined) {
      throw new Error(`missing test expression op: ${opIndex}`);
    }

    const at = {
      instructionIndex,
      opIndex,
      epoch: opEpochs[opIndex]!
    };
    const effectKind = testEffectKindForExpressionOp(op);

    if (effectKind !== undefined) {
      roots.push(...effectValueRootsForOp(
        {
          expressionPaths,
          valueTimeline: input.valueTimeline
        },
        op,
        effectKind,
        at
      ));
    }

    roots.push(...(input.extraUses?.get(opIndex) ?? []).map((root) => ({
      ...root,
      at
    })));
  }

  return roots.flatMap(expandRootUse);
}

export function branchExpressionPaths(
  expressionBlock: IrExprBlock,
  instructionIndex = 0
): PathMap {
  const paths = new Map<number, BranchPaths>();

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    if (expressionBlock[opIndex]?.op === "conditionalJump") {
      paths.set(opIndex, {
        taken: branchPath(instructionIndex, opIndex, "taken"),
        notTaken: branchPath(instructionIndex, opIndex, "notTaken")
      });
    }
  }

  return paths;
}

function testEffectKindForExpressionOp(
  op: IrExprBlock[number]
): EffectKind | undefined {
  switch (op.op) {
    case "memory.guard":
      return "memoryGuard";
    case "set":
      return op.target.kind === "mem" ? "memoryStore" : undefined;
    case "jump":
      return "jump";
    case "conditionalJump":
      return "branch";
    case "hostTrap":
      return "hostTrap";
    case "let32":
      return "producedValue";
    case "next":
      return "fallthrough";
    case "flags.set":
      return undefined;
  }
}
