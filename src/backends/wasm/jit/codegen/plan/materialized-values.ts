import type {
  IrExprBlock,
  IrExpressionSourceMap
} from "#backends/wasm/codegen/expressions.js";
import type { Reg32 } from "#x86/isa/types.js";
import { jitInstructionWrittenReg } from "./operand-analysis.js";
import type {
  JitCodegenPlan,
  JitExitMaterializationPlan,
  JitExitPoint,
  MaterializationTarget
} from "./types.js";

export type JitMaterializedValueUsePlanInput = Readonly<{
  expressionBlock: IrExprBlock;
  sourceExpressionMap: IrExpressionSourceMap;
}>;

export type JitMaterializedValueUsePlan = Readonly<{
  expressionUseIndexesByInstruction: readonly ReadonlySet<number>[];
}>;

export function planJitMaterializedValueUses(
  instructions: readonly JitMaterializedValueUsePlanInput[],
  codegenPlan: Pick<
    JitCodegenPlan,
    "block" | "exitPoints" | "exitMaterializations"
  >
): JitMaterializedValueUsePlan {
  if (instructions.length !== codegenPlan.block.instructions.length) {
    throw new Error(
      `JIT materialized value instruction count mismatch: ${instructions.length} !== ${codegenPlan.block.instructions.length}`
    );
  }

  const exitStoreRegsByInstructionOp = registerExitStoreRegsByInstructionOpIndex(
    codegenPlan.exitPoints,
    codegenPlan.exitMaterializations
  );
  const expressionUseIndexesByInstruction = new Array<Set<number>>(instructions.length);
  let neededAfterInstruction = new Set<Reg32>();

  for (let instructionIndex = instructions.length - 1; instructionIndex >= 0; instructionIndex -= 1) {
    const sourceInstruction = codegenPlan.block.instructions[instructionIndex];
    const instruction = instructions[instructionIndex];

    if (sourceInstruction === undefined || instruction === undefined) {
      throw new Error(`missing JIT instruction while planning materialized value uses: ${instructionIndex}`);
    }

    const exitStoreRegsByOp = exitStoreRegsByInstructionOp[instructionIndex] ?? new Map();
    const needed = new Set(neededAfterInstruction);
    const sourceUseIndexes = new Set<number>();

    // Exit points refer to source IR op indexes, while value-cache planning
    // consumes expression-block indexes, so reachability is computed on source
    // IR and mapped through the expression builder's source-placement map.
    for (let opIndex = sourceInstruction.ir.length - 1; opIndex >= 0; opIndex -= 1) {
      const op = sourceInstruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while planning materialized value uses: ${instructionIndex}:${opIndex}`);
      }

      if (op.op === "set") {
        const writtenReg = jitInstructionWrittenReg(sourceInstruction, op.target, op.accessWidth ?? 32);

        if (writtenReg !== undefined) {
          if (op.role === "registerMaterialization" && needed.has(writtenReg)) {
            sourceUseIndexes.add(opIndex);
          }

          needed.delete(writtenReg);
        }
      }

      for (const reg of exitStoreRegsByOp.get(opIndex) ?? []) {
        needed.add(reg);
      }
    }

    expressionUseIndexesByInstruction[instructionIndex] = expressionMaterializedValueUseIndexes(
      instruction,
      sourceUseIndexes
    );
    neededAfterInstruction = needed;
  }

  return { expressionUseIndexesByInstruction };
}

function expressionMaterializedValueUseIndexes(
  instruction: JitMaterializedValueUsePlanInput,
  sourceUseIndexes: ReadonlySet<number>
): Set<number> {
  const expressionIndexes = new Set<number>();

  for (const sourceOpIndex of sourceUseIndexes) {
    const placements = instruction.sourceExpressionMap.placementsBySourceOpIndex.get(sourceOpIndex) ?? [];
    const emittedOpPlacements = placements.filter((placement) => placement.kind === "emittedOp");

    if (emittedOpPlacements.length === 0) {
      throw new Error(`could not map JIT source op to expression op: ${sourceOpIndex}`);
    }

    for (const placement of emittedOpPlacements) {
      if (instruction.expressionBlock[placement.expressionOpIndex] === undefined) {
        throw new Error(`missing mapped JIT expression op: ${placement.expressionOpIndex}`);
      }

      expressionIndexes.add(placement.expressionOpIndex);
    }
  }

  return expressionIndexes;
}

function registerExitStoreRegsByInstructionOpIndex(
  exitPoints: readonly JitExitPoint[],
  exitMaterializations: readonly JitExitMaterializationPlan[]
): readonly ReadonlyMap<number, readonly Reg32[]>[] {
  const regs: Map<number, Reg32[]>[] = [];

  for (const exitPoint of exitPoints) {
    const exitMaterialization = exitMaterializations[exitPoint.exitMaterializationIndex];

    if (exitMaterialization === undefined) {
      throw new Error(`missing JIT exit materialization: ${exitPoint.exitMaterializationIndex}`);
    }

    const exitRegs = exitMaterialization.stores.flatMap(({ target }) => materializationTargetRegs(target));

    if (exitRegs.length === 0) {
      continue;
    }

    let instructionRegs = regs[exitPoint.instructionIndex];

    if (instructionRegs === undefined) {
      instructionRegs = new Map();
      regs[exitPoint.instructionIndex] = instructionRegs;
    }

    const opRegs = instructionRegs.get(exitPoint.opIndex) ?? [];

    for (const reg of exitRegs) {
      if (!opRegs.includes(reg)) {
        opRegs.push(reg);
      }
    }

    instructionRegs.set(exitPoint.opIndex, opRegs);
  }

  return regs;
}

function materializationTargetRegs(target: MaterializationTarget): readonly Reg32[] {
  switch (target.kind) {
    case "reg32":
    case "regPart":
      return [target.reg];
    case "aluFlags":
      return [];
  }
}
