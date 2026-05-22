import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type {
  JitBoundExprBlock,
  JitBoundExprOp
} from "#backends/wasm/jit/ir/bound-expressions.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  buildExit,
  type Exit,
  type ExitKind,
  type ExitSnapshot,
  type ExitPlacement
} from "./exits.js";
import {
  classifyRuntimeAction,
  classifyExits,
  type RuntimeActionKind
} from "./runtime-classifier.js";
import type { BlockProgress } from "./block-progress.js";
import type { PathMap } from "./paths.js";
import type { Timeline, TimelineView } from "./timeline-types.js";

export type BlockRuntimeInput = Readonly<{
  expressions: JitBoundExprBlock;
  timeline: Timeline;
  expressionPaths: PathMap;
  progress: BlockProgress;
}>;

type RuntimeActionBase<TKind extends RuntimeActionKind> = Readonly<{
  kind: TKind;
  at: ExitPlacement;
}>;

export type AnalyzedRuntimeAction<TExit extends Exit = Exit> =
  | RuntimeActionBase<"memoryGuard"> & Readonly<{ faultExit: TExit }>
  | RuntimeActionBase<"memoryStore">
  | RuntimeActionBase<"jump"> & Readonly<{ exit: TExit }>
  | RuntimeActionBase<"branch"> & Readonly<{ taken: TExit; notTaken: TExit }>
  | RuntimeActionBase<"hostTrap"> & Readonly<{ exit: TExit }>
  | RuntimeActionBase<"fallthrough"> & Readonly<{ exit: TExit }>;

export type BlockRuntimeAnalysis = Readonly<{
  actions: readonly AnalyzedRuntimeAction[];
  exits: readonly Exit[];
  progress: BlockProgress;
}>;

export function analyzeBlockRuntime(
  input: BlockRuntimeInput
): BlockRuntimeAnalysis {
  const { expressions } = input;
  const actions: AnalyzedRuntimeAction[] = [];
  const exits: Exit[] = [];
  let instructionCountDelta = input.progress.instructionCountDelta;

  for (const [opIndex, op] of expressions.entries()) {
    const isFinalOp = opIndex === expressions.length - 1;
    const progressBeforeOp = { instructionCountDelta };
    const runtimeActionKind = classifyRuntimeAction(op, isFinalOp);
    const exitKinds = classifyExits(op, isFinalOp);

    if (runtimeActionKind === undefined && exitKinds.length !== 0) {
      throw new Error(`JIT exits without an owning runtime action at ${opIndex}`);
    }

    const at = { opIndex };
    const view = input.timeline.viewAt(opIndex);
    const exitRecords = exitKinds.map((kind) =>
      buildExitForOp({
        at,
        kind,
        snapshot: exitSnapshotBeforeOp(
          input,
          opIndex,
          exitProgressForOp(kind, progressBeforeOp)
        ),
        paths: input.expressionPaths,
        op,
        view,
        expressions
      })
    );

    if (runtimeActionKind !== undefined) {
      const action = runtimeActionForOp(runtimeActionKind, at, exitRecords);

      actions.push(action);
    }

    exits.push(...exitRecords);

    if (localFallthroughCommitsInstruction(op, isFinalOp)) {
      instructionCountDelta += 1;
    }
  }

  return {
    actions,
    exits,
    progress: {
      instructionCountDelta
    }
  };
}

export function timelineSnapshotPointsForExpressions(
  expressions: JitBoundExprBlock
): ReadonlySet<number> {
  return new Set(expressions.flatMap((op, opIndex) =>
    classifyExits(op, opIndex === expressions.length - 1).length === 0
      ? []
      : [opIndex]
  ));
}

function runtimeActionForOp(
  kind: RuntimeActionKind,
  at: ExitPlacement,
  exits: readonly Exit[]
): AnalyzedRuntimeAction {
  switch (kind) {
    case "memoryGuard":
      return { kind, at, faultExit: onlyExit(exits) };
    case "memoryStore":
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
  input: BlockRuntimeInput,
  opIndex: number,
  progress: BlockProgress
): ExitSnapshot {
  return {
    progress,
    valueState: input.timeline.snapshotAt(opIndex)
  };
}

function exitProgressForOp(
  kind: ExitKind,
  progressBeforeOp: BlockProgress
): BlockProgress {
  return exitCommitsInstruction(kind)
    ? {
        instructionCountDelta: progressBeforeOp.instructionCountDelta + 1
      }
    : progressBeforeOp;
}

function exitCommitsInstruction(kind: ExitKind): boolean {
  switch (kind) {
    case "fallthrough":
    case "jump":
    case "branchTaken":
    case "branchNotTaken":
    case "hostTrap":
      return true;
    case "memoryReadFault":
    case "memoryWriteFault":
      return false;
  }
}

function buildExitForOp(input: Readonly<{
  at: ExitPlacement;
  kind: ExitKind;
  snapshot: ExitSnapshot;
  paths: PathMap;
  op: JitBoundExprOp;
  view: TimelineView;
  expressions: JitBoundExprBlock;
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
  expressions: JitBoundExprBlock
): Readonly<{ staticLinkTarget?: number }> {
  const target = staticLinkTargetForExit(kind, op, expressions);

  return target === undefined
    ? {}
    : { staticLinkTarget: target };
}

function staticLinkTargetForExit(
  kind: ExitKind,
  op: JitBoundExprOp,
  expressions: JitBoundExprBlock
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
  expressions: JitBoundExprBlock
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
  expressions: JitBoundExprBlock
): number | undefined {
  for (const op of expressions) {
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
    throw new Error("expected one JIT runtime action exit");
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
  kind: RuntimeActionKind,
  at: ExitPlacement
): void {
  if (exits.length !== 0) {
    throw new Error(`JIT ${kind} runtime action at ${at.opIndex} must not have exits`);
  }
}

function localFallthroughCommitsInstruction(
  op: JitBoundExprOp,
  isFinalOp: boolean
): boolean {
  return op.op === "next" && !isFinalOp;
}
