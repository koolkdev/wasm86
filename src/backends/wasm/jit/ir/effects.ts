import type { Reg32 } from "#x86/isa/types.js";
import type { IrOp, ValueRef } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  analyzeJitConditionUses,
  indexJitExitConditionValues,
  indexJitLocalConditionValues,
  type JitConditionUse
} from "#backends/wasm/jit/ir/condition-uses.js";
import {
  jitOpExits,
  type JitOpExitKind
} from "#backends/wasm/jit/ir/effect-primitives.js";
import { jitStorageReg } from "#backends/wasm/jit/ir/values.js";

export type JitOpEffects = Readonly<{
  exits: readonly JitOpExitKind[];
  localConditionValues: readonly ValueRef[];
  exitConditionValues: readonly ValueRef[];
  registerWriteReg?: Reg32;
  conditionUse?: JitConditionUse;
}>;

export type JitInstructionEffects = Readonly<{
  ops: readonly JitOpEffects[];
}>;

export type JitEffectIndex = Readonly<{
  instructions: readonly JitInstructionEffects[];
}>;

export function indexJitEffects(block: JitIrBlock): JitEffectIndex {
  const localConditionValues = indexJitLocalConditionValues(block);
  const exitConditionValues = indexJitExitConditionValues(block);
  const conditionUses = analyzeJitConditionUses(block, localConditionValues, exitConditionValues);
  const instructions: JitInstructionEffects[] = [];

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while indexing JIT op effects: ${instructionIndex}`);
    }

    const ops: JitOpEffects[] = [];

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while indexing JIT op effects: ${instructionIndex}:${opIndex}`);
      }

      let opEffects: JitOpEffects = {
        exits: jitOpExits(op, instruction),
        localConditionValues: localConditionValues.get(instructionIndex)?.get(opIndex) ?? [],
        exitConditionValues: exitConditionValues.get(instructionIndex)?.get(opIndex) ?? []
      };

      const registerWriteReg = jitRegisterWriteReg(op, instruction.operands);

      if (registerWriteReg !== undefined) {
        opEffects = { ...opEffects, registerWriteReg };
      }

      const conditionUse = conditionUses.get(instructionIndex)?.get(opIndex);

      if (conditionUse !== undefined) {
        opEffects = { ...opEffects, conditionUse };
      }

      ops.push(opEffects);
    }

    instructions.push({ ops });
  }

  return { instructions };
}

export function jitOpEffectsAt(
  effects: JitEffectIndex,
  instructionIndex: number,
  opIndex: number
): JitOpEffects {
  const instructionEffects = effects.instructions[instructionIndex];

  if (instructionEffects === undefined) {
    throw new Error(`missing JIT instruction effects: ${instructionIndex}`);
  }

  const opEffects = instructionEffects.ops[opIndex];

  if (opEffects === undefined) {
    throw new Error(`missing JIT op effects: ${instructionIndex}:${opIndex}`);
  }

  return opEffects;
}

export function jitConditionValuesAt(
  effects: JitEffectIndex,
  instructionIndex: number,
  opIndex: number,
  kind: "localCondition" | "exitCondition"
): readonly ValueRef[] {
  const opEffects = jitOpEffectsAt(effects, instructionIndex, opIndex);

  return kind === "localCondition"
    ? opEffects.localConditionValues
    : opEffects.exitConditionValues;
}

export function jitOpExitsAt(
  effects: JitEffectIndex,
  instructionIndex: number,
  opIndex: number
): readonly JitOpExitKind[] {
  return jitOpEffectsAt(effects, instructionIndex, opIndex).exits;
}

export function jitOpHasExit(
  effects: JitEffectIndex,
  instructionIndex: number,
  opIndex: number
): boolean {
  return jitOpExitsAt(effects, instructionIndex, opIndex).length !== 0;
}

export function jitConditionUseAt(
  effects: JitEffectIndex,
  instructionIndex: number,
  opIndex: number
): JitConditionUse | undefined {
  return jitOpEffectsAt(effects, instructionIndex, opIndex).conditionUse;
}

export function jitRegisterWriteRegAt(
  effects: JitEffectIndex,
  instructionIndex: number,
  opIndex: number
): Reg32 | undefined {
  return jitOpEffectsAt(effects, instructionIndex, opIndex).registerWriteReg;
}

function jitRegisterWriteReg(
  op: IrOp,
  operands: JitIrBlockInstruction["operands"]
): Reg32 | undefined {
  if (op.op !== "set") {
    return undefined;
  }

  return jitStorageReg(op.target, operands);
}
