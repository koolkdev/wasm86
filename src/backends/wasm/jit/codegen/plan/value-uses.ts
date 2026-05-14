import type {
  IrExprBlock,
  IrExprOp,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import {
  jitValueDependencies,
  jitValuesEqual,
  simplifyJitValue,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import {
  rootValuePathScope,
  type JitControlPathScopesMap,
  type JitBranchValuePathScopes,
  type JitValuePathScope
} from "./control-paths.js";
import {
  jitTimelineExpressionValueAt,
  jitTimelineValueRefValueAt,
  type JitInstructionValueTimeline
} from "./value-timeline.js";

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

export type JitPlacedExpressionValueUse = Readonly<{
  value: JitValue;
  pathScope: JitValuePathScope;
  purpose: string;
}>;

export type JitPlannedValueUseInstructionInput = Readonly<{
  expressionBlock: IrExprBlock;
  valueTimeline: JitInstructionValueTimeline;
  expressionPathScopes: JitControlPathScopesMap;
  materializationValueUsesByExpressionIndex: ReadonlyMap<
    number,
    readonly JitPlacedExpressionValueUse[]
  >;
}>;

export function buildJitPlannedValueUsesForInstructions(
  instructions: readonly JitPlannedValueUseInstructionInput[]
): readonly JitPlannedValueUse[] {
  const uses: JitPlannedValueUse[] = [];
  let currentEpoch = 0;

  for (let instructionIndex = 0; instructionIndex < instructions.length; instructionIndex += 1) {
    const instruction = instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT planned-value-use instruction: ${instructionIndex}`);
    }

    const writeExpressionOpIndexes = new Set(
      instruction.valueTimeline.logicalWrites.map((write) => write.expressionOpIndex)
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

function plannedValueUsesForOp(
  instruction: JitPlannedValueUseInstructionInput,
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
  instruction: JitPlannedValueUseInstructionInput,
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
  instruction: JitPlannedValueUseInstructionInput,
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
  instruction: JitPlannedValueUseInstructionInput,
  opIndex: number
): boolean {
  return instruction.valueTimeline.logicalWrites.some((write) =>
    write.expressionOpIndex === opIndex
  );
}

function materializationUsesForOp(
  instruction: JitPlannedValueUseInstructionInput,
  placement: JitValueUsePlacement
): readonly JitPlannedValueUse[] {
  return (instruction.materializationValueUsesByExpressionIndex.get(placement.opIndex) ?? [])
    .flatMap((use) =>
      valueUseTree(
        use.value,
        placement,
        use.pathScope,
        use.purpose
      )
    );
}

function valueUsesForStorage(
  instruction: JitPlannedValueUseInstructionInput,
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
  instruction: JitPlannedValueUseInstructionInput,
  value: IrValueExpr,
  placement: JitValueUsePlacement,
  pathScope: JitValuePathScope,
  purpose: string
): readonly JitPlannedValueUse[] {
  const jitValue = jitValueForValue(instruction, value, placement.opIndex);

  return jitValue === undefined
    ? childValueUsesForValue(instruction, value, placement, pathScope, purpose)
    : valueUseTree(jitValue, placement, pathScope, purpose);
}

function childValueUsesForValue(
  instruction: JitPlannedValueUseInstructionInput,
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

function valueUseTree(
  value: JitValue,
  placement: JitValueUsePlacement,
  pathScope: JitValuePathScope,
  purpose: string
): readonly JitPlannedValueUse[] {
  const simplified = simplifyJitValue(value);

  return uniquePlannedUses([
    {
      value: simplified,
      placement,
      pathScope,
      purpose
    },
    ...jitValueDependencies(simplified).flatMap((dependency) =>
      valueUseTree(dependency, placement, pathScope, purpose)
    )
  ]);
}

function uniquePlannedUses(uses: readonly JitPlannedValueUse[]): readonly JitPlannedValueUse[] {
  const unique: JitPlannedValueUse[] = [];

  for (const use of uses) {
    if (!unique.some((entry) =>
      jitValuesEqual(entry.value, use.value) &&
        entry.placement.instructionIndex === use.placement.instructionIndex &&
        entry.placement.opIndex === use.placement.opIndex &&
        entry.placement.epoch === use.placement.epoch &&
        entry.pathScope.id === use.pathScope.id &&
        entry.purpose === use.purpose
    )) {
      unique.push(use);
    }
  }

  return unique;
}

function jitValueForValue(
  instruction: JitPlannedValueUseInstructionInput,
  value: IrValueExpr,
  opIndex: number
): JitValue | undefined {
  switch (value.kind) {
    case "var":
    case "const":
    case "nextEip":
      return jitTimelineValueRefValueAt(instruction.valueTimeline, opIndex, value);
    case "source":
    case "address":
    case "flags.condition":
    case "value.binary":
    case "value.unary":
    case "value.select":
      return jitTimelineExpressionValueAt(instruction.valueTimeline, opIndex, value);
  }
}
