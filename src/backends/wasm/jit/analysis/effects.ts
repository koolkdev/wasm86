import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { JitInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  buildExit,
  type Exit,
  type ExitKind,
  type Placement
} from "./exits.js";
import {
  classifyEffect,
  classifyExits,
  type EffectKind
} from "./effect-classifier.js";
import { snapshotForEffectExit } from "./exit-snapshots.js";
import { instructionDeltaAfterOp } from "./instruction-progress.js";
import type { PathMap } from "./paths.js";
import type { Timeline } from "./timeline.js";

export type InstructionAnalysis = Readonly<{
  instruction: JitInstruction;
  instructionIndex: number;
  expressionBlock: IrExprBlock;
  sourceMap: IrExpressionSourceMap;
  valueTimeline: Timeline;
  paths: PathMap;
}>;

export type EffectsInput = Readonly<{
  instructions: readonly InstructionAnalysis[];
}>;

export type EffectsAnalysis<TExit extends Exit = Exit> = Readonly<{
  effects: readonly EffectInfo<TExit>[];
  exits: readonly TExit[];
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

export function analyzeEffects(input: EffectsInput): EffectsAnalysis {
  const effects: EffectInfo[] = [];
  const exits: Exit[] = [];
  let instructionCountDelta = 0;

  for (const instructionAnalysis of input.instructions) {
    const { instruction, instructionIndex } = instructionAnalysis;

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while analyzing effects: ${instructionIndex}:${opIndex}`);
      }

      const effectKind = classifyEffect(op, instruction);
      const exitKinds = classifyExits(op, instruction);

      if (effectKind === undefined && exitKinds.length !== 0) {
        throw new Error(`JIT exits without an owning effect at ${instructionIndex}:${opIndex}`);
      }

      const at = { instructionIndex, opIndex };
      const exitRecords = exitKinds.map((kind) =>
        buildExit({
          instruction,
          at,
          kind,
          snapshot: snapshotForEffectExit({
            kind,
            instruction: instructionAnalysis,
            sourceOpIndex: opIndex,
            instructionCountDelta
          }),
          paths: instructionAnalysis.paths
        })
      );

      if (effectKind !== undefined) {
        effects.push(effectForOp(effectKind, at, exitRecords));
      }

      exits.push(...exitRecords);
      instructionCountDelta += instructionDeltaAfterOp(op, instruction);
    }
  }

  assertUniqueExitIds(exits);

  return {
    effects,
    exits
  };
}

export function effectAt<TExit extends Exit>(
  effects: readonly EffectInfo<TExit>[],
  instructionIndex: number,
  opIndex: number
): EffectInfo<TExit> | undefined {
  return effects.find((effect) =>
    effect.at.instructionIndex === instructionIndex &&
    effect.at.opIndex === opIndex
  );
}

export function reattachEffectExits<TExit extends Exit>(
  effects: readonly EffectInfo[],
  exits: readonly TExit[]
): readonly EffectInfo<TExit>[] {
  const exitsById = new Map(exits.map((exit) => [exit.id, exit]));

  return effects.map((effect) => {
    switch (effect.kind) {
      case "memoryGuard":
        return {
          ...effect,
          faultExit: exitsById.get(effect.faultExit.id)!
        };
      case "jump":
      case "hostTrap":
      case "fallthrough":
        return {
          ...effect,
          exit: exitsById.get(effect.exit.id)!
        };
      case "branch":
        return {
          ...effect,
          taken: exitsById.get(effect.taken.id)!,
          notTaken: exitsById.get(effect.notTaken.id)!
        };
      case "memoryStore":
      case "memoryLoad":
        return effect;
    }
  });
}

function effectForOp(
  kind: EffectKind,
  at: Placement,
  exits: readonly Exit[]
): EffectInfo {
  switch (kind) {
    case "memoryGuard":
      return { kind, at, faultExit: onlyExit(exits, "memory guard", at) };
    case "memoryStore":
      assertNoExits(exits, kind, at);
      return { kind, at };
    case "memoryLoad":
      assertNoExits(exits, kind, at);
      return { kind, at };
    case "jump":
      return { kind, at, exit: onlyExit(exits, "jump", at) };
    case "branch":
      return {
        kind,
        at,
        taken: findKindExit(exits, "branchTaken", at),
        notTaken: findKindExit(exits, "branchNotTaken", at)
      };
    case "hostTrap":
      return { kind, at, exit: onlyExit(exits, "host trap", at) };
    case "fallthrough":
      return { kind, at, exit: onlyExit(exits, "fallthrough", at) };
  }
}

function onlyExit(
  exits: readonly Exit[],
  label: string,
  at: Placement
): Exit {
  const [exit] = exits;

  if (exit === undefined || exits.length !== 1) {
    throw new Error(`JIT ${label} effect at ${at.instructionIndex}:${at.opIndex} must have exactly one exit`);
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

function assertUniqueExitIds(exits: readonly Exit[]): void {
  const ids = new Set<string>();

  for (const exit of exits) {
    if (ids.has(exit.id)) {
      throw new Error(`duplicate JIT exit id: ${exit.id}`);
    }

    ids.add(exit.id);
  }
}
