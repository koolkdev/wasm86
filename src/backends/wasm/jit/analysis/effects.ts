import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type {
  JitBoundExprOp
} from "#backends/wasm/jit/ir/bound-expressions.js";
import type { BlockExpressions } from "#backends/wasm/jit/ir/block-expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  buildExit,
  type Exit,
  type ExitKind,
  type ExitSnapshot,
  type ExitPlacement
} from "./exits.js";
import {
  classifyEffect,
  classifyExits,
  type EffectKind
} from "./effect-classifier.js";
import {
  addBlockProgress,
  snapshotForExit,
  type BlockProgress
} from "./block-progress.js";
import type { PathMap } from "./paths.js";
import type { Timeline, TimelineView } from "./timeline-types.js";

export type BlockEffectInput = Readonly<{
  expressions: BlockExpressions;
  timeline: Timeline;
  expressionPaths: PathMap;
  progress: BlockProgress;
}>;

type EffectInfoBase<TKind extends EffectKind> = Readonly<{
  kind: TKind;
  at: ExitPlacement;
}>;

export type EffectInfo<TExit extends Exit = Exit> =
  | EffectInfoBase<"memoryGuard"> & Readonly<{ faultExit: TExit }>
  | EffectInfoBase<"memoryStore">
  | EffectInfoBase<"memoryLoad">
  | EffectInfoBase<"jump"> & Readonly<{ exit: TExit }>
  | EffectInfoBase<"branch"> & Readonly<{ taken: TExit; notTaken: TExit }>
  | EffectInfoBase<"hostTrap"> & Readonly<{ exit: TExit }>
  | EffectInfoBase<"fallthrough"> & Readonly<{ exit: TExit }>;

export type BlockEffectAnalysis = Readonly<{
  effects: readonly EffectInfo[];
  exits: readonly Exit[];
}>;

export function analyzeBlockEffects(
  input: BlockEffectInput
): BlockEffectAnalysis {
  const { expressions } = input;
  const effects: EffectInfo[] = [];
  const exits: Exit[] = [];

  for (let position = 0; position < expressions.ops.length; position += 1) {
    const entry = expressions.ops[position];

    if (entry === undefined) {
      throw new Error(`missing JIT expression op while analyzing effects: ${position}`);
    }

    const { opIndex, op } = entry;
    const currentProgress = addBlockProgress(input.progress, entry.progress);

    if (opIndex !== position) {
      throw new Error(`JIT block expression op index mismatch: ${opIndex} !== ${position}`);
    }

    const isFinalOp = position === expressions.ops.length - 1;
    const effectKind = classifyEffect(op, isFinalOp);
    const exitKinds = classifyExits(op, isFinalOp);

    if (effectKind === undefined && exitKinds.length !== 0) {
      throw new Error(`JIT exits without an owning effect at ${opIndex}`);
    }

    const at = { opIndex };
    const view = input.timeline.viewAt(opIndex);
    const exitRecords = exitKinds.map((kind) =>
      buildExitForOp({
        at,
        kind,
        snapshot: snapshotForExit(
          kind,
          exitSnapshotBeforeOp(
            input,
            opIndex,
            currentProgress
          )
        ),
        paths: input.expressionPaths,
        op,
        view,
        expressions
      })
    );

    if (effectKind !== undefined) {
      const effect = effectForOp(effectKind, at, exitRecords);

      effects.push(effect);
    }

    exits.push(...exitRecords);
  }

  return {
    effects,
    exits
  };
}

export function timelineSnapshotPointsForExpressions(
  expressions: BlockExpressions
): ReadonlySet<number> {
  return new Set(expressions.ops.flatMap(({ opIndex, op }, position) =>
    classifyExits(op, position === expressions.ops.length - 1).length === 0
      ? []
      : [opIndex]
  ));
}

function effectForOp(
  kind: EffectKind,
  at: ExitPlacement,
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
  input: BlockEffectInput,
  opIndex: number,
  progress: BlockProgress
): ExitSnapshot {
  return {
    progress,
    valueState: input.timeline.snapshotAt(opIndex)
  };
}

function buildExitForOp(input: Readonly<{
  at: ExitPlacement;
  kind: ExitKind;
  snapshot: ExitSnapshot;
  paths: PathMap;
  op: JitBoundExprOp;
  view: TimelineView;
  expressions: BlockExpressions;
}>): Exit {
  const { at, kind, snapshot, paths, op, view, expressions } = input;
  const base = { at, snapshot, paths };

  switch (kind) {
    case "memoryReadFault":
    case "memoryWriteFault":
      if (op.op !== "memory.guard") {
        return invalidExitKindForOp(kind, op);
      }

      return buildExit({ ...base, kind, op });
    case "fallthrough":
      if (op.op !== "next") {
        return invalidExitKindForOp(kind, op);
      }

      return buildExit({
        ...base,
        kind,
        op,
        ...staticLinkTargetInput(kind, op, expressions)
      });
    case "jump":
      if (op.op !== "jump") {
        return invalidExitKindForOp(kind, op);
      }

      return buildExit({
        ...base,
        kind,
        op,
        ...targetValueInput(kind, op, view),
        ...staticLinkTargetInput(kind, op, expressions)
      });
    case "branchTaken":
    case "branchNotTaken":
      if (op.op !== "conditionalJump") {
        return invalidExitKindForOp(kind, op);
      }

      return buildExit({
        ...base,
        kind,
        op,
        ...targetValueInput(kind, op, view),
        ...staticLinkTargetInput(kind, op, expressions)
      });
    case "hostTrap":
      if (op.op !== "hostTrap") {
        return invalidExitKindForOp(kind, op);
      }

      return buildExit({ ...base, kind, op });
  }
}

function invalidExitKindForOp(kind: ExitKind, op: JitBoundExprOp): never {
  throw new Error(`JIT ${kind} exit cannot be built from ${op.op}`);
}

function targetValueInput(
  kind: ExitKind,
  op: JitBoundExprOp,
  view: TimelineView
): Readonly<{ targetValue?: JitValue }> {
  const target = targetExpressionForExit(kind, op);

  return target === undefined
    ? {}
    : { targetValue: view.value(target) };
}

function targetExpressionForExit(
  kind: ExitKind,
  op: JitBoundExprOp
): IrValueExpr | undefined {
  switch (kind) {
    case "jump":
      return op.op === "jump" ? op.target : undefined;
    case "branchTaken":
      return op.op === "conditionalJump" ? op.taken : undefined;
    case "branchNotTaken":
      return op.op === "conditionalJump" ? op.notTaken : undefined;
    case "memoryReadFault":
    case "memoryWriteFault":
    case "fallthrough":
    case "hostTrap":
      return undefined;
  }
}

function staticLinkTargetInput(
  kind: ExitKind,
  op: JitBoundExprOp,
  expressions: BlockExpressions
): Readonly<{ staticLinkTarget?: number }> {
  const target = staticLinkTargetForExit(kind, op, expressions);

  return target === undefined
    ? {}
    : { staticLinkTarget: target };
}

function staticLinkTargetForExit(
  kind: ExitKind,
  op: JitBoundExprOp,
  expressions: BlockExpressions
): number | undefined {
  switch (kind) {
    case "fallthrough":
      return op.op === "next"
        ? op.target.value
        : undefined;
    case "jump":
    case "branchTaken":
    case "branchNotTaken": {
      const target = targetExpressionForExit(kind, op);

      return target === undefined
        ? undefined
        : staticLinkTargetForExpression(target, expressions);
    }
    case "memoryReadFault":
    case "memoryWriteFault":
    case "hostTrap":
      return undefined;
  }
}

function staticLinkTargetForExpression(
  value: IrValueExpr,
  expressions: BlockExpressions
): number | undefined {
  switch (value.kind) {
    case "source":
      return undefined;
    case "var":
      return materializedStaticTarget(value.id, expressions);
    case "const":
      return value.value;
    case "nextEip":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return undefined;
  }
}

function materializedStaticTarget(
  varId: number,
  expressions: BlockExpressions
): number | undefined {
  for (const entry of expressions.ops) {
    const { op } = entry;

    if (op.op === "let32" && op.dst.id === varId) {
      return op.value.kind === "const"
        ? op.value.value
        : undefined;
    }
  }

  return undefined;
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
  at: ExitPlacement
): Exit {
  const exit = exits.find((entry) => entry.kind === kind);

  if (exit === undefined) {
    throw new Error(`missing JIT ${kind} exit at ${at.opIndex}`);
  }

  return exit;
}

function assertNoExits(
  exits: readonly Exit[],
  kind: EffectKind,
  at: ExitPlacement
): void {
  if (exits.length !== 0) {
    throw new Error(`JIT ${kind} effect at ${at.opIndex} must not have exits`);
  }
}
