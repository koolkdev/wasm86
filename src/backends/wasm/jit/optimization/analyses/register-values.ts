import { reg32, type Reg32 } from "#x86/isa/types.js";
import type { JitIrBlock, JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import { jitIrOpIsTerminator } from "#backends/wasm/jit/ir/semantics.js";
import { JitValueTracker } from "#backends/wasm/jit/ir/value-tracker.js";
import {
  jitStorageReg,
  jitValueIsSymbolicReg,
  jitValueReadsReg,
  jitValueUsesSymbolicReg,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import { jitStorageRegisterAccess } from "#backends/wasm/jit/ir/register-prefix-values.js";
import { JitRegisterValues } from "#backends/wasm/jit/optimization/registers/values.js";
import {
  analyzeJitBarriers,
  jitInstructionHasBarrier,
  jitOpBarriersAt,
  jitOpHasBarrier,
  type JitBarrierAnalysis
} from "#backends/wasm/jit/ir/barriers.js";

export type JitRegisterValueProducer = Readonly<{
  instructionIndex: number;
  opIndex: number;
  reg: Reg32;
  value: JitValue;
  retained: boolean;
}>;

export type JitRegisterValueRead = Readonly<{
  instructionIndex: number;
  opIndex: number;
  reg: Reg32;
  value: JitValue;
  reason: "get" | "address";
}>;

export type JitRegisterValueFold = Readonly<{
  instructionIndex: number;
  opIndex: number;
  kind: "get" | "address";
  value: JitValue;
  regs: readonly Reg32[];
}>;

export type JitRegisterMaterializationReason =
  | "preInstructionExit"
  | "exit"
  | "read"
  | "clobber"
  | "blockEnd";

export type JitRegisterMaterialization = Readonly<{
  instructionIndex: number;
  opIndex?: number;
  phase: "beforeInstruction" | "beforeOp" | "beforeExit" | "blockEnd";
  reason: JitRegisterMaterializationReason;
  regs: readonly Reg32[];
  values: readonly JitRegisterMaterializedValue[];
}>;

export type JitRegisterMaterializedValue = Readonly<{
  reg: Reg32;
  value: JitValue;
}>;

export type JitRegisterValueAnalysis = Readonly<{
  producers: readonly JitRegisterValueProducer[];
  reads: readonly JitRegisterValueRead[];
  folds: readonly JitRegisterValueFold[];
  materializations: readonly JitRegisterMaterialization[];
  finalValues: ReadonlyMap<Reg32, JitValue>;
}>;

export function analyzeJitRegisterValues(
  block: JitIrBlock,
  barriers: JitBarrierAnalysis = analyzeJitBarriers(block)
): JitRegisterValueAnalysis {
  const registers = new JitRegisterValues();
  const producers: JitRegisterValueProducer[] = [];
  const reads: JitRegisterValueRead[] = [];
  const folds: JitRegisterValueFold[] = [];
  const materializations: JitRegisterMaterialization[] = [];

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while analyzing register values: ${instructionIndex}`);
    }

    if (jitInstructionHasBarrier(barriers, instructionIndex, "preInstructionExit")) {
      materializeAll(registers, materializations, {
        instructionIndex,
        phase: "beforeInstruction",
        reason: "preInstructionExit"
      });
    }

    analyzeInstruction(block, instruction, instructionIndex, registers, producers, reads, folds, materializations, barriers);
  }

  return {
    producers,
    reads,
    folds,
    materializations,
    finalValues: new Map(registers.trackedValues)
  };
}

export function validateJitRegisterValueAnalysis(analysis: JitRegisterValueAnalysis): void {
  for (const materialization of analysis.materializations) {
    const remainingRegs = new Set(materialization.regs);

    for (const { reg } of materialization.values) {
      if (!remainingRegs.delete(reg)) {
        throw new Error(`register materialization has unexpected value for ${reg}`);
      }
    }

    if (remainingRegs.size !== 0) {
      throw new Error(`register materialization is missing values for ${[...remainingRegs].join(", ")}`);
    }
  }
}

function analyzeInstruction(
  block: JitIrBlock,
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  registers: JitRegisterValues,
  producers: JitRegisterValueProducer[],
  reads: JitRegisterValueRead[],
  folds: JitRegisterValueFold[],
  materializations: JitRegisterMaterialization[],
  barriers: JitBarrierAnalysis
): void {
  const values = new JitValueTracker();

  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while analyzing register values: ${instructionIndex}:${opIndex}`);
    }

    if (isFinalBlockTerminatorWithoutExit(block, barriers, instructionIndex, opIndex, op)) {
      materializeAll(registers, materializations, {
        instructionIndex,
        opIndex,
        phase: "beforeOp",
        reason: "blockEnd"
      });
    }

    switch (op.op) {
      case "get": {
        if (op.role === "symbolicRead") {
          values.recordOp(op, instruction);
          break;
        }

        const reg = jitStorageReg(op.source, instruction.operands);
        const accessWidth = op.accessWidth ?? 32;
        const value = registers.valueForStorage(op.source, instruction.operands, accessWidth, op.signed === true);

        if (reg !== undefined && value !== undefined && registers.hasStorageValue(op.source, instruction.operands, accessWidth)) {
          reads.push({ instructionIndex, opIndex, reg, value, reason: "get" });
          folds.push({ instructionIndex, opIndex, kind: "get", value, regs: [reg] });
        }

        if (reg !== undefined && value === undefined && registers.get(reg) !== undefined) {
          materializeRegs(registers, materializations, [reg], {
            instructionIndex,
            opIndex,
            phase: "beforeOp",
            reason: "read"
          });
        }

        values.recordOp(op, instruction, registers.trackedRegisterValues);
        break;
      }
      case "address": {
        const readRegs = registers.regsReadByEffectiveAddress(op.operand, instruction.operands);
        const value = registers.valueForEffectiveAddress(op.operand, instruction.operands);

        if (value === undefined) {
          materializeRegs(registers, materializations, readRegs, {
            instructionIndex,
            opIndex,
            phase: "beforeOp",
            reason: "read"
          });
        } else {
          folds.push({ instructionIndex, opIndex, kind: "address", value, regs: readRegs });

          for (const reg of readRegs) {
            const regValue = registers.get(reg);

            if (regValue !== undefined) {
              reads.push({ instructionIndex, opIndex, reg, value: regValue, reason: "address" });
            }
          }
        }

        values.recordOp(op, instruction, registers.trackedRegisterValues);
        break;
      }
      case "set": {
        if (op.role === "registerMaterialization") {
          const reg = registerBarrierReg(barriers, instructionIndex, opIndex, "write");

          if (reg !== undefined) {
            materializeDependencies(registers, materializations, reg, {
              instructionIndex,
              opIndex,
              phase: "beforeOp",
              reason: "clobber"
            }, { includeSymbolicRegs: true });
            registers.delete(reg);
            values.deleteValuesReadingReg(reg);
          }
          break;
        }

        const reg = registerBarrierReg(barriers, instructionIndex, opIndex, "write");
        const value = values.valueFor(op.value);
        const accessWidth = op.accessWidth ?? 32;
        const access = jitStorageRegisterAccess(op.target, instruction.operands, accessWidth);
        // Retention is a semantic decision, not a profitability decision. Pure JitValue
        // trees may stay symbolic; barriers/materialization handle lifetime safety, and
        // the value-cache plan decides whether repeated emission deserves a Wasm local.
        const retained = access !== undefined &&
          access.width === 32 &&
          value !== undefined &&
          (
            !isImmediatelyMaterializedAtExit(instruction, instructionIndex, opIndex, barriers) ||
            jitValueIsSymbolicReg(value, access.reg)
          );

        if (reg !== undefined && access !== undefined) {
          if (access.width !== 32) {
            materializeRegs(registers, materializations, [reg], {
              instructionIndex,
              opIndex,
              phase: "beforeOp",
              reason: "clobber"
            });
          }

          materializeDependencies(registers, materializations, reg, {
            instructionIndex,
            opIndex,
            phase: "beforeOp",
            reason: "clobber"
          }, { includeSymbolicRegs: !retained });

          if (retained && value !== undefined) {
            registers.set(reg, value);
          } else if (value !== undefined && access.width !== 32) {
            registers.write(reg, access.width, access.bitOffset, value);
          } else {
            registers.delete(reg);
          }
          values.deleteValuesReadingReg(reg);

          if (access.width === 32 && value !== undefined) {
            producers.push({ instructionIndex, opIndex, reg, value, retained });
          }
        }
        break;
      }
      default:
        values.recordOp(op, instruction, registers.trackedRegisterValues);
        break;
    }

    if (jitOpHasBarrier(barriers, instructionIndex, opIndex, "exit")) {
      materializeAll(registers, materializations, {
        instructionIndex,
        opIndex,
        phase: "beforeExit",
        reason: "exit"
      });
    }
  }
}

function materializeAll(
  registers: JitRegisterValues,
  materializations: JitRegisterMaterialization[],
  point: Omit<JitRegisterMaterialization, "regs" | "values">
): void {
  materializeRegs(registers, materializations, [...registers.trackedValues.keys()], point);
}

function materializeDependencies(
  registers: JitRegisterValues,
  materializations: JitRegisterMaterialization[],
  clobberedReg: Reg32,
  point: Omit<JitRegisterMaterialization, "regs" | "values">,
  options: Readonly<{ includeSymbolicRegs?: boolean }> = {}
): void {
  const regs = [...registers.trackedValues].flatMap(([reg, value]) =>
    reg !== clobberedReg && jitValueDependsOnClobberedReg(value, clobberedReg, options.includeSymbolicRegs === true)
      ? [reg]
      : []
  );

  materializeRegs(registers, materializations, regs, point);
  registers.deletePartialDependencies(clobberedReg, { includeSymbolicRegs: options.includeSymbolicRegs === true });
}

function jitValueDependsOnClobberedReg(
  value: JitValue,
  clobberedReg: Reg32,
  includeSymbolicRegs: boolean
): boolean {
  return jitValueReadsReg(value, clobberedReg) ||
    (includeSymbolicRegs && jitValueUsesSymbolicReg(value, clobberedReg));
}

function materializeRegs(
  registers: JitRegisterValues,
  materializations: JitRegisterMaterialization[],
  regs: readonly Reg32[],
  point: Omit<JitRegisterMaterialization, "regs" | "values">
): void {
  const materializedRegs = materializationClosure(registers, regs);
  const values = materializedRegs.flatMap((reg) => {
    const value = registers.get(reg);

    return value === undefined ? [] : [{ reg, value }];
  });

  if (values.length === 0) {
    return;
  }

  materializations.push({
    ...point,
    regs: values.map(({ reg }) => reg),
    values
  });

  for (const { reg } of values) {
    registers.delete(reg);
  }
}

function materializationClosure(registers: JitRegisterValues, regs: readonly Reg32[]): readonly Reg32[] {
  const materializedRegs = new Set(regs);
  let changed = true;

  while (changed) {
    changed = false;

    const writeRegs = new Set([...materializedRegs].filter((reg) => {
      const value = registers.get(reg);

      return value !== undefined && !jitValueIsSymbolicReg(value, reg);
    }));

    for (const [reg, value] of registers.trackedValues) {
      if (materializedRegs.has(reg)) {
        continue;
      }

      for (const writeReg of writeRegs) {
        if (jitValueDependsOnClobberedReg(value, writeReg, true)) {
          materializedRegs.add(reg);
          changed = true;
          break;
        }
      }
    }
  }

  return reg32.filter((reg) => materializedRegs.has(reg));
}

function registerBarrierReg(
  barriers: JitBarrierAnalysis,
  instructionIndex: number,
  opIndex: number,
  reason: "write"
): Reg32 | undefined {
  return jitOpBarriersAt(barriers, instructionIndex, opIndex)
    .find((barrier) => barrier.reason === reason)
    ?.reg;
}

function isImmediatelyMaterializedAtExit(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  opIndex: number,
  barriers: JitBarrierAnalysis
): boolean {
  const nextOpIndex = opIndex + 1;
  const nextOp = instruction.ir[nextOpIndex];

  return nextOp !== undefined &&
    jitIrOpIsTerminator(nextOp) &&
    jitOpHasBarrier(barriers, instructionIndex, nextOpIndex, "exit");
}

function isFinalBlockTerminatorWithoutExit(
  block: JitIrBlock,
  barriers: JitBarrierAnalysis,
  instructionIndex: number,
  opIndex: number,
  op: JitIrOp
): boolean {
  const instruction = block.instructions[instructionIndex];

  return instructionIndex === block.instructions.length - 1 &&
    instruction !== undefined &&
    opIndex === instruction.ir.length - 1 &&
    jitIrOpIsTerminator(op) &&
    !jitOpHasBarrier(barriers, instructionIndex, opIndex, "exit");
}
