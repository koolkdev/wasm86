import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import {
  rootValuePathScope,
  type JitControlPathScopesMap,
  type JitBranchValuePathScopes,
  type JitValuePathScope
} from "./control-paths.js";
import {
  opView,
  type Timeline
} from "#backends/wasm/jit/analysis/timeline.js";

export type JitValueUsePlacement = Readonly<{
  instructionIndex: number;
  opIndex: number;
  epoch: number;
}>;

export type JitPlannedValueUse = Readonly<{
  value: JitValue;
  placement: JitValueUsePlacement;
  pathScope: JitValuePathScope;
  purpose: string;
}>;

export type JitValueUseRoot = Readonly<{
  value: JitValue;
  pathScope: JitValuePathScope;
  purpose: string;
}>;

export type JitExpressionValueUseRoot = Readonly<{
  kind: "expression";
  value: IrValueExpr;
  pathScope: JitValuePathScope;
  purpose: string;
}>;

export type JitJitValueUseRoot = Readonly<{
  kind: "jitValue";
  value: JitValue;
  pathScope: JitValuePathScope;
  purpose: string;
}>;

export type JitPlannedValueRoot =
  | JitExpressionValueUseRoot
  | JitJitValueUseRoot;

export type JitValueUseInstructionInput = Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: Timeline;
  expressionPathScopes: JitControlPathScopesMap;
  materializationUses: ReadonlyMap<
    number,
    readonly JitValueUseRoot[]
  >;
}>;

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
      return [plannedValueUse(root.value, placement, root.pathScope, root.purpose)];
    case "expression":
      return valueUsesForValue(
        instruction,
        root.value,
        placement,
        root.pathScope,
        root.purpose
      );
  }
}

function plannedValueUsesForOp(
  instruction: JitValueUseInstructionInput,
  op: IrExprOp,
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  const root = rootValuePathScope();

  return [
    ...expressionUsesForOp(instruction, op, placement, root),
    ...materializationUsesForOp(instruction, placement)
  ];
}

function expressionUsesForOp(
  instruction: JitValueUseInstructionInput,
  op: IrExprOp,
  placement: JitValueUsePlacement,
  root: JitValuePathScope
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
      const branchPathScopes = requiredBranchPathScopes(instruction, placement);

      return [
        ...valueUsesForValue(instruction, op.condition, placement, root, "branchCondition"),
        ...valueUsesForValue(
          instruction,
          op.taken,
          placement,
          branchPathScopes.taken,
          "branchTarget"
        ),
        ...valueUsesForValue(
          instruction,
          op.notTaken,
          placement,
          branchPathScopes.notTaken,
          "branchTarget"
        )
      ];
    }
    case "hostTrap":
      return valueUsesForValue(instruction, op.vector, placement, root, "hostTrapVector");
  }
}

function requiredBranchPathScopes(
  instruction: JitValueUseInstructionInput,
  placement: JitValueUsePlacement
): JitBranchValuePathScopes {
  const pathScopes = instruction.expressionPathScopes.get(placement.opIndex);

  if (pathScopes === undefined) {
    throw new Error(
      `missing JIT branch path scopes for expression op: ${placement.instructionIndex}:${placement.opIndex}`
    );
  }

  return pathScopes;
}

function instructionHasLogicalWriteAt(
  instruction: JitValueUseInstructionInput,
  opIndex: number
): boolean {
  return instruction.valueTimeline.writes.some((write) =>
    write.opIndex === opIndex
  );
}

function materializationUsesForOp(
  instruction: JitValueUseInstructionInput,
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  return (instruction.materializationUses.get(placement.opIndex) ?? [])
    .map((use) =>
      plannedValueUse(
        use.value,
        placement,
        use.pathScope,
        use.purpose
      )
    );
}

function valueUsesForStorage(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  storage: IrStorageExpr,
  placement: JitValueUsePlacement,
  pathScope: JitValuePathScope,
  purpose: string
): readonly JitPlannedValueUse[] {
  return storage.kind === "mem"
    ? valueUsesForValue(instruction, storage.address, placement, pathScope, purpose)
    : [];
}

function valueUsesForValue(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  value: IrValueExpr,
  placement: JitValueUsePlacement,
  pathScope: JitValuePathScope,
  purpose: string
): readonly JitPlannedValueUse[] {
  const jitValue = jitValueForValue(instruction, value, placement.opIndex);

  return jitValue === undefined
    ? childValueUsesForValue(instruction, value, placement, pathScope, purpose)
    : [plannedValueUse(jitValue, placement, pathScope, purpose)];
}

function childValueUsesForValue(
  instruction: Pick<JitValueUseInstructionInput, "valueTimeline">,
  value: IrValueExpr,
  placement: JitValueUsePlacement,
  pathScope: JitValuePathScope,
  purpose: string
): readonly JitPlannedValueUse[] {
  switch (value.kind) {
    case "source":
      return valueUsesForStorage(instruction, value.source, placement, pathScope, purpose);
    case "value.binary":
      return [
        ...valueUsesForValue(instruction, value.a, placement, pathScope, purpose),
        ...valueUsesForValue(instruction, value.b, placement, pathScope, purpose)
      ];
    case "value.unary":
      return valueUsesForValue(instruction, value.value, placement, pathScope, purpose);
    case "value.select":
      return [
        ...valueUsesForValue(instruction, value.condition, placement, pathScope, purpose),
        ...valueUsesForValue(instruction, value.whenTrue, placement, pathScope, purpose),
        ...valueUsesForValue(instruction, value.whenFalse, placement, pathScope, purpose)
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
  pathScope: JitValuePathScope,
  purpose: string
): JitPlannedValueUse {
  const simplified = simplifyValue(value);

  return {
    value: simplified,
    placement,
    pathScope,
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
