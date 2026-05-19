import type {
  IrExprBlock,
  IrExprOp,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import type { InstructionMetadata } from "#backends/wasm/jit/ir/types.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
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
import type { Timeline, TimelineView } from "./timeline-types.js";

export type EffectInstructionInput = Readonly<{
  instruction: InstructionMetadata;
  index: number;
  expressions: IrExprBlock;
  timeline: Timeline;
  expressionPaths: PathMap;
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
  const { instruction, index, expressions } = instructionAnalysis;
  const flow: MutableInstructionFlow = {
    effects: [],
    exits: []
  };
  let currentInstructionCountDelta = instructionAnalysis.progress.instructionCountDelta;

  for (let opIndex = 0; opIndex < expressions.length; opIndex += 1) {
    const op = expressions[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT expression op while analyzing effects: ${index}:${opIndex}`);
    }

    const effectKind = classifyEffect(op, instruction);
    const exitKinds = classifyExits(op, instruction);

    if (effectKind === undefined && exitKinds.length !== 0) {
      throw new Error(`JIT exits without an owning effect at ${index}:${opIndex}`);
    }

    const at = { instructionIndex: index, opIndex };
    const view = instructionAnalysis.timeline.viewAt(opIndex);
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
        paths: instructionAnalysis.expressionPaths,
        ...targetValueInput(kind, op, view),
        ...staticLinkTargetInput(kind, op, instruction, expressions)
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

export function timelineSnapshotPointsForExpressions(
  instruction: InstructionMetadata,
  expressions: IrExprBlock
): ReadonlySet<number> {
  return new Set(expressions.flatMap((op, opIndex) =>
    classifyExits(op, instruction).length === 0
      ? []
      : [opIndex]
  ));
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
  opIndex: number,
  progress: InstructionProgress
): ExitSnapshot {
  return {
    progress,
    valueState: instruction.timeline.snapshotAt(opIndex)
  };
}

function targetValueInput(
  kind: ExitKind,
  op: IrExprOp,
  view: TimelineView
): Readonly<{ targetValue?: JitValue }> {
  const target = targetExpressionForExit(kind, op);

  return target === undefined
    ? {}
    : { targetValue: view.value(target) };
}

function targetExpressionForExit(
  kind: ExitKind,
  op: IrExprOp
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
  op: IrExprOp,
  instruction: InstructionMetadata,
  expressions: IrExprBlock
): Readonly<{ staticLinkTarget?: number }> {
  const target = staticLinkTargetForExit(kind, op, instruction, expressions);

  return target === undefined
    ? {}
    : { staticLinkTarget: target };
}

function staticLinkTargetForExit(
  kind: ExitKind,
  op: IrExprOp,
  instruction: InstructionMetadata,
  expressions: IrExprBlock
): number | undefined {
  switch (kind) {
    case "fallthrough":
      return instruction.nextEip;
    case "jump":
    case "branchTaken":
    case "branchNotTaken": {
      const target = targetExpressionForExit(kind, op);

      return target === undefined
        ? undefined
        : staticLinkTargetForExpression(target, instruction, expressions);
    }
    case "memoryReadFault":
    case "memoryWriteFault":
    case "hostTrap":
      return undefined;
  }
}

function staticLinkTargetForExpression(
  value: IrValueExpr,
  instruction: InstructionMetadata,
  expressions: IrExprBlock
): number | undefined {
  switch (value.kind) {
    case "nextEip":
      return instruction.nextEip;
    case "source":
      return value.source.kind === "operand"
        ? staticOperandLinkTarget(instruction, value.source.index)
        : undefined;
    case "var":
      return materializedStaticOperandTarget(value.id, instruction, expressions);
    case "const":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return undefined;
  }
}

function materializedStaticOperandTarget(
  varId: number,
  instruction: InstructionMetadata,
  expressions: IrExprBlock
): number | undefined {
  const producer = expressions.find((op): op is Extract<IrExprOp, { op: "let32" }> =>
    op.op === "let32" && op.dst.id === varId
  );

  return producer?.value.kind !== "source" || producer.value.source.kind !== "operand"
    ? undefined
    : staticOperandLinkTarget(instruction, producer.value.source.index);
}

function staticOperandLinkTarget(
  instruction: InstructionMetadata,
  operandIndex: number
): number | undefined {
  const binding = instruction.operands[operandIndex];

  return binding?.kind === "static.relTarget" ? binding.target : undefined;
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
