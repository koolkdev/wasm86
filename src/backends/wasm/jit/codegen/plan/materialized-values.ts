import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import type { Reg32 } from "#x86/isa/types.js";
import { jitInstructionWrittenReg } from "./operand-analysis.js";
import type { JitCodegenPlan, JitMaterializationNeed } from "./types.js";

export type JitMaterializedValueUsePlanInput = Readonly<{
  expressionBlock: IrExprBlock;
}>;

export type JitMaterializedValueUsePlan = Readonly<{
  expressionUseIndexesByInstruction: readonly ReadonlySet<number>[];
}>;

export function planJitMaterializedValueUses(
  instructions: readonly JitMaterializedValueUsePlanInput[],
  codegenPlan: Pick<JitCodegenPlan, "block" | "materializationNeeds">
): JitMaterializedValueUsePlan {
  if (instructions.length !== codegenPlan.block.instructions.length) {
    throw new Error(
      `JIT materialized value instruction count mismatch: ${instructions.length} !== ${codegenPlan.block.instructions.length}`
    );
  }

  const exitStoreRegsByInstructionOp = registerExitStoreRegsByInstructionOpIndex(
    codegenPlan.materializationNeeds
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
    // IR and mapped by registerMaterialization ordinal to expression ops.
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
      sourceInstruction,
      instruction,
      sourceUseIndexes
    );
    neededAfterInstruction = needed;
  }

  return { expressionUseIndexesByInstruction };
}

function expressionMaterializedValueUseIndexes(
  sourceInstruction: JitIrBlockInstruction,
  instruction: JitMaterializedValueUsePlanInput,
  sourceUseIndexes: ReadonlySet<number>
): Set<number> {
  const selectedOrdinals = new Set<number>();
  const expressionIndexes = new Set<number>();
  let ordinal = 0;

  for (let opIndex = 0; opIndex < sourceInstruction.ir.length; opIndex += 1) {
    const op = sourceInstruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while mapping materialized value uses: ${opIndex}`);
    }

    if (op.op !== "set" || op.role !== "registerMaterialization") {
      continue;
    }

    if (sourceUseIndexes.has(opIndex)) {
      selectedOrdinals.add(ordinal);
    }

    ordinal += 1;
  }

  ordinal = 0;

  for (let opIndex = 0; opIndex < instruction.expressionBlock.length; opIndex += 1) {
    const op = instruction.expressionBlock[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT expression op while mapping materialized value uses: ${opIndex}`);
    }

    if (op.op !== "set" || op.role !== "registerMaterialization") {
      continue;
    }

    if (selectedOrdinals.has(ordinal)) {
      expressionIndexes.add(opIndex);
    }

    ordinal += 1;
  }

  if (expressionIndexes.size !== selectedOrdinals.size) {
    throw new Error("could not map JIT materialized value use indexes to expression ops");
  }

  return expressionIndexes;
}

type JitRegisterExitStoreNeed = JitMaterializationNeed & Readonly<{
  consumer: "registerExitStore";
  value: Readonly<{ kind: "committedRegister"; reg: Reg32 }>;
}>;

function registerExitStoreRegsByInstructionOpIndex(
  materializationNeeds: readonly JitMaterializationNeed[]
): readonly ReadonlyMap<number, readonly Reg32[]>[] {
  const regs: Map<number, Reg32[]>[] = [];
  const registerExitStoreNeeds = materializationNeeds.filter(isRegisterExitStoreNeed);

  for (const need of registerExitStoreNeeds) {
    let instructionRegs = regs[need.placement.instructionIndex];

    if (instructionRegs === undefined) {
      instructionRegs = new Map();
      regs[need.placement.instructionIndex] = instructionRegs;
    }

    const opRegs = instructionRegs.get(need.placement.opIndex) ?? [];

    if (!opRegs.includes(need.value.reg)) {
      opRegs.push(need.value.reg);
    }

    instructionRegs.set(need.placement.opIndex, opRegs);
  }

  return regs;
}

function isRegisterExitStoreNeed(need: JitMaterializationNeed): need is JitRegisterExitStoreNeed {
  return need.consumer === "registerExitStore" && need.value.kind === "committedRegister";
}
