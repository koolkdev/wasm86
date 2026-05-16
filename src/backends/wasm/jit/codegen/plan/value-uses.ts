import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import {
  rootPath,
  type Path,
  type PathMap
} from "#backends/wasm/jit/analysis/paths.js";
import {
  opView,
  type Timeline
} from "#backends/wasm/jit/analysis/timeline.js";
import type {
  PlannedExit,
  StoreTarget
} from "./exit-stores.js";

export type JitValueUsePlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  epoch: number;
}>;

export type JitPlannedValueUse = Readonly<{
  value: JitValue;
  placement: JitValueUsePlacement;
  path: Path;
  purpose: string;
}>;

export type JitValueUseRoot = Readonly<{
  value: JitValue;
  path: Path;
  purpose: string;
}>;

export type JitExitStoreUsePlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  exitIndex: number;
  exitId: string;
  reason: ExitReasonValue;
  exitStoreIndex: number;
}>;

export type JitExitStoreUse = Readonly<{
  purpose: "exitStore";
  target: StoreTarget;
  value: JitValue;
  placement: JitExitStoreUsePlacement;
  path: Path;
}>;

export type JitExpressionValueUseRoot = Readonly<{
  kind: "expression";
  value: IrValueExpr;
  path: Path;
  purpose: string;
}>;

export type JitJitValueUseRoot = Readonly<{
  kind: "jitValue";
  value: JitValue;
  path: Path;
  purpose: string;
}>;

export type JitPlannedValueRoot =
  | JitExpressionValueUseRoot
  | JitJitValueUseRoot;

export type JitValueUseInstructionInput = Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: Timeline;
  expressionPaths: PathMap;
  extraUses: ReadonlyMap<
    number,
    readonly JitValueUseRoot[]
  >;
}>;

export function exitStoreUsesForPlannedExits(
  exits: readonly PlannedExit[]
): readonly JitExitStoreUse[] {
  return exits.flatMap((exit, exitIndex) =>
    exitStoreUsesForExit(exit, exitIndex)
  );
}

export function exitStoreUsesForExit(
  exit: PlannedExit,
  exitIndex: number
): readonly JitExitStoreUse[] {
  const placement = {
    instructionIndex: exit.at.instructionIndex,
    opIndex: exit.at.opIndex,
    exitIndex,
    exitId: exit.id,
    reason: exit.reason,
    exitStoreIndex: exit.exitStoreIndex
  };

  return exit.stores.map((store) => ({
    purpose: "exitStore",
    target: store.target,
    value: store.value,
    placement,
    path: exit.path
  }));
}

export function planJitValueUses(
  instructions: readonly JitValueUseInstructionInput[]
): readonly JitPlannedValueUse[] {
  const uses: JitPlannedValueUse[] = [];
  let currentEpoch = 0;

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT planned-value-use instruction: ${instructionIndex}`);
    }

    const writeExpressionOpIndexes = new Set(
      instruction.valueTimeline.writes.map((write) => write.opIndex)
    );

    for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
      const op = instruction.expressionBlock[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT planned-value-use expression op: ${instructionIndex}:${opIndex}`);
      }

      const placement = { instructionIndex, opIndex, epoch: currentEpoch };

      uses.push(...plannedValueUsesForOp(instruction, op, placement));

      if (writeExpressionOpIndexes.has(opIndex)) {
        currentEpoch += 1;
      }
    }
  }

  return uses;
}

export function plannedValueUsesForRoots(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  roots: readonly JitPlannedValueRoot[],
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  return roots.flatMap((root) =>
    plannedValueUsesForRoot(instruction, root, placement)
  );
}

export function plannedValueUsesForRoot(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  root: JitPlannedValueRoot,
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  switch (root.kind) {
    case "jitValue":
      return [plannedValueUse(root.value, placement, root.path, root.purpose)];
    case "expression":
      return valueUsesForValue(
        instruction,
        root.value,
        placement,
        root.path,
        root.purpose
      );
  }
}

function plannedValueUsesForOp(
  instruction: JitValueUseInstructionInput,
  op: IrExprOp,
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  const root = rootPath();

  return [
    ...expressionUsesForOp(instruction, op, placement, root),
    ...extraUsesForOp(instruction, placement)
  ];
}

function expressionUsesForOp(
  instruction: JitValueUseInstructionInput,
  op: IrExprOp,
  placement: JitValueUsePlacement,
  root: Path
): readonly JitPlannedValueUse[] {
  switch (op.op) {
    case "let32":
    case "flags.set":
    case "next":
      return [];
    case "memory.guard":
      return valueUsesForValue(instruction, op.address, placement, root, "memoryGuardAddress");
    case "set": {
      const stateUpdateOnly = instructionHasLogicalWriteAt(instruction, placement.opIndex);

      return [
        ...valueUsesForStorage(instruction, op.target, placement, root, "storageAddress"),
        ...(stateUpdateOnly
          ? []
          : valueUsesForValue(instruction, op.value, placement, root, "expression"))
      ];
    }
    case "jump":
      return valueUsesForValue(instruction, op.target, placement, root, "controlTarget");
    case "conditionalJump": {
      const branchPaths = instruction.expressionPaths.get(placement.opIndex)!;

      return [
        ...valueUsesForValue(instruction, op.condition, placement, root, "branchCondition"),
        ...valueUsesForValue(
          instruction,
          op.taken,
          placement,
          branchPaths.taken,
          "branchTarget"
        ),
        ...valueUsesForValue(
          instruction,
          op.notTaken,
          placement,
          branchPaths.notTaken,
          "branchTarget"
        )
      ];
    }
    case "hostTrap":
      return valueUsesForValue(instruction, op.vector, placement, root, "hostTrapVector");
  }
}

function instructionHasLogicalWriteAt(
  instruction: JitValueUseInstructionInput,
  opIndex: number
): boolean {
  return instruction.valueTimeline.writes.some((write) =>
    write.opIndex === opIndex
  );
}

function extraUsesForOp(
  instruction: JitValueUseInstructionInput,
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  return (instruction.extraUses.get(placement.opIndex) ?? [])
    .map((use) =>
      plannedValueUse(
        use.value,
        placement,
        use.path,
        use.purpose
      )
    );
}

function valueUsesForStorage(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  storage: IrStorageExpr,
  placement: JitValueUsePlacement,
  path: Path,
  purpose: string
): readonly JitPlannedValueUse[] {
  return storage.kind === "mem"
    ? valueUsesForValue(instruction, storage.address, placement, path, purpose)
    : [];
}

function valueUsesForValue(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  value: IrValueExpr,
  placement: JitValueUsePlacement,
  path: Path,
  purpose: string
): readonly JitPlannedValueUse[] {
  const jitValue = jitValueForValue(instruction, value, placement.opIndex);

  return jitValue === undefined
    ? childValueUsesForValue(instruction, value, placement, path, purpose)
    : [plannedValueUse(jitValue, placement, path, purpose)];
}

function childValueUsesForValue(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  value: IrValueExpr,
  placement: JitValueUsePlacement,
  path: Path,
  purpose: string
): readonly JitPlannedValueUse[] {
  switch (value.kind) {
    case "source":
      return valueUsesForStorage(instruction, value.source, placement, path, purpose);
    case "value.binary":
      return [
        ...valueUsesForValue(instruction, value.a, placement, path, purpose),
        ...valueUsesForValue(instruction, value.b, placement, path, purpose)
      ];
    case "value.unary":
      return valueUsesForValue(instruction, value.value, placement, path, purpose);
    case "value.select":
      return [
        ...valueUsesForValue(instruction, value.condition, placement, path, purpose),
        ...valueUsesForValue(instruction, value.whenTrue, placement, path, purpose),
        ...valueUsesForValue(instruction, value.whenFalse, placement, path, purpose)
      ];
    case "var":
    case "const":
    case "nextEip":
    case "address":
    case "flags.condition":
      return [];
  }
}

function plannedValueUse(
  value: JitValue,
  placement: JitValueUsePlacement,
  path: Path,
  purpose: string
): JitPlannedValueUse {
  const simplified = simplifyValue(value);

  return {
    value: simplified,
    placement,
    path,
    purpose
  };
}

function jitValueForValue(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  value: IrValueExpr,
  opIndex: number
): JitValue | undefined {
  const view = opView(instruction.valueTimeline, opIndex);

  switch (value.kind) {
    case "var":
    case "const":
    case "nextEip":
      return view.ref(value);
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return view.expression(value);
  }
}
