import type {
  IrExpressionSourceMap,
  IrExpressionSourcePlacement
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  buildExit,
  type Exit,
  type ExitKind,
  type ExitSnapshot,
  type Placement
} from "./exits.js";
import {
  classifyEffect,
  classifyExits,
  type EffectKind
} from "./effect-classifier.js";
import {
  instructionDeltaAfterOp,
  snapshotForExit,
  type InstructionProgress
} from "./instruction-progress.js";
import type { PathMap } from "./paths.js";
import type { Timeline } from "./timeline-types.js";

export type EffectInstructionInput = Readonly<{
  instruction: JitInstruction;
  index: number;
  sourceMap: IrExpressionSourceMap;
  timeline: Timeline;
  sourcePaths: PathMap;
  progress: InstructionProgress;
}>;

type EffectInfoBase<TKind extends EffectKind> = Readonly<{
  kind: TKind;
  at: Placement;
}>;

export type EffectInfo<TExit extends Exit = Exit> =
  | EffectInfoBase<"memoryGuard"> & Readonly<{ faultExit: TExit }>
  | EffectInfoBase<"memoryStore">
  | EffectInfoBase<"memoryLoad">
  | EffectInfoBase<"jump"> & Readonly<{ exit: TExit }>
  | EffectInfoBase<"branch"> & Readonly<{ taken: TExit; notTaken: TExit }>
  | EffectInfoBase<"hostTrap"> & Readonly<{ exit: TExit }>
  | EffectInfoBase<"fallthrough"> & Readonly<{ exit: TExit }>;

export type InstructionFlow<TExit extends Exit = Exit> = Readonly<{
  effects: readonly EffectInfo<TExit>[];
  exits: readonly TExit[];
}>;

type MutableInstructionFlow<TExit extends Exit = Exit> = {
  effects: EffectInfo<TExit>[];
  exits: TExit[];
};

export function analyzeInstructionEffects(
  instructionAnalysis: EffectInstructionInput
): InstructionFlow {
  const { instruction, index } = instructionAnalysis;
  const flow: MutableInstructionFlow = {
    effects: [],
    exits: []
  };
  let currentInstructionCountDelta = instructionAnalysis.progress.instructionCountDelta;

  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while analyzing effects: ${index}:${opIndex}`);
    }

    const effectKind = classifyEffect(op, instruction);
    const exitKinds = classifyExits(op, instruction);

    if (effectKind === undefined && exitKinds.length !== 0) {
      throw new Error(`JIT exits without an owning effect at ${index}:${opIndex}`);
    }

    const at = { instructionIndex: index, opIndex };
    const exitRecords = exitKinds.map((kind) =>
      buildExit({
        instruction,
        at,
        kind,
        snapshot: snapshotForExit(
          kind,
          exitSnapshotBeforeOp(
            instructionAnalysis,
            opIndex,
            { instructionCountDelta: currentInstructionCountDelta }
          )
        ),
        paths: instructionAnalysis.sourcePaths
      })
    );

    if (effectKind !== undefined) {
      const effect = effectForOp(effectKind, at, exitRecords);

      flow.effects.push(effect);
    }

    flow.exits.push(...exitRecords);
    currentInstructionCountDelta += instructionDeltaAfterOp(op, instruction);
  }

  return flow;
}

function effectForOp(
  kind: EffectKind,
  at: Placement,
  exits: readonly Exit[]
): EffectInfo {
  switch (kind) {
    case "memoryGuard":
      return { kind, at, faultExit: onlyExit(exits) };
    case "memoryStore":
      assertNoExits(exits, kind, at);
      return { kind, at };
    case "memoryLoad":
      assertNoExits(exits, kind, at);
      return { kind, at };
    case "jump":
      return { kind, at, exit: onlyExit(exits) };
    case "branch":
      return {
        kind,
        at,
        taken: findKindExit(exits, "branchTaken", at),
        notTaken: findKindExit(exits, "branchNotTaken", at)
      };
    case "hostTrap":
      return { kind, at, exit: onlyExit(exits) };
    case "fallthrough":
      return { kind, at, exit: onlyExit(exits) };
  }
}

function exitSnapshotBeforeOp(
  instruction: EffectInstructionInput,
  sourceOpIndex: number,
  progress: InstructionProgress
): ExitSnapshot {
  return {
    progress,
    valueState: valueStateBeforeSourceOp(instruction, sourceOpIndex)
  };
}

function valueStateBeforeSourceOp(
  instruction: EffectInstructionInput,
  sourceOpIndex: number
) {
  const expressionOpIndexes = expressionOpIndexesForSourceOp(
    instruction.sourceMap,
    sourceOpIndex
  );

  if (expressionOpIndexes.length !== 1) {
    throw new Error(
      `expected one JIT expression op for source state ${sourceOpIndex}, got ${expressionOpIndexes.length}`
    );
  }

  return instruction.timeline.snapshotAt(expressionOpIndexes[0]!);
}

function expressionOpIndexesForSourceOp(
  sourceMap: IrExpressionSourceMap,
  sourceOpIndex: number
): readonly number[] {
  return (sourceMap.placementsBySourceOpIndex.get(sourceOpIndex) ?? [])
    .filter(isEmittedExpressionOp)
    .map((placement) => placement.expressionOpIndex);
}

function isEmittedExpressionOp(
  placement: IrExpressionSourcePlacement
): boolean {
  return placement.kind === "emittedOp";
}

function onlyExit(exits: readonly Exit[]): Exit {
  const [exit] = exits;

  if (exit === undefined || exits.length !== 1) {
    throw new Error("expected one JIT effect exit");
  }

  return exit;
}

function findKindExit(
  exits: readonly Exit[],
  kind: ExitKind,
  at: Placement
): Exit {
  const exit = exits.find((entry) => entry.kind === kind);

  if (exit === undefined) {
    throw new Error(`missing JIT ${kind} exit at ${at.instructionIndex}:${at.opIndex}`);
  }

  return exit;
}

function assertNoExits(
  exits: readonly Exit[],
  kind: EffectKind,
  at: Placement
): void {
  if (exits.length !== 0) {
    throw new Error(`JIT ${kind} effect at ${at.instructionIndex}:${at.opIndex} must not have exits`);
  }
}
