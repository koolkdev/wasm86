import type { Reg32 } from "#x86/isa/types.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import {
  indexJitEffects,
  jitOpExitsAt,
  jitOpHasExit,
  jitRegisterWriteRegAt,
  type JitEffectIndex
} from "#backends/wasm/jit/ir/effects.js";
import type { JitOpExitKind } from "#backends/wasm/jit/ir/effect-primitives.js";

export type JitBarrierReason =
  | "exit"
  | "write";

export type JitBarrier = Readonly<{
  instructionIndex: number;
  opIndex?: number;
  reason: JitBarrierReason;
  exits?: readonly JitOpExitKind[];
  reg?: Reg32;
}>;

export type JitInstructionBarrierIndex = Readonly<{
  barriers: readonly JitBarrier[];
  ops: readonly (readonly JitBarrier[])[];
}>;

export type JitBarrierAnalysis = Readonly<{
  effects: JitEffectIndex;
  barriers: readonly JitBarrier[];
  instructions: readonly JitInstructionBarrierIndex[];
}>;

export type JitRegisterBarrierReason = JitBarrierReason;
export type JitRegisterBarrier = JitBarrier;
export type JitRegisterBarrierAnalysis = JitBarrierAnalysis;

type JitMutableInstructionBarrierIndex = {
  barriers: JitBarrier[];
  ops: JitBarrier[][];
};

export function analyzeJitBarriers(
  block: JitIrBlock,
  effects: JitEffectIndex = indexJitEffects(block)
): JitBarrierAnalysis {
  const barriers: JitBarrier[] = [];
  const instructions: JitMutableInstructionBarrierIndex[] = [];

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while analyzing JIT barriers: ${instructionIndex}`);
    }

    const instructionBarriers: JitMutableInstructionBarrierIndex = {
      barriers: [],
      ops: instruction.ir.map(() => [])
    };

    instructions.push(instructionBarriers);

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while analyzing JIT barriers: ${instructionIndex}:${opIndex}`);
      }

      if (jitOpHasExit(effects, instructionIndex, opIndex)) {
        pushBarrier(barriers, instructionBarriers, {
          instructionIndex,
          opIndex,
          reason: "exit",
          exits: jitOpExitsAt(effects, instructionIndex, opIndex)
        });
      }

      const registerWriteReg = jitRegisterWriteRegAt(effects, instructionIndex, opIndex);

      if (registerWriteReg !== undefined) {
        pushBarrier(barriers, instructionBarriers, {
          instructionIndex,
          opIndex,
          reason: "write",
          reg: registerWriteReg
        });
      }
    }
  }

  return { effects, barriers, instructions };
}

export const analyzeJitRegisterBarriers = analyzeJitBarriers;

export function jitInstructionHasBarrier(
  analysis: JitBarrierAnalysis,
  instructionIndex: number,
  reason: JitBarrierReason
): boolean {
  return jitInstructionBarriersAt(analysis, instructionIndex).some((barrier) => barrier.reason === reason);
}

export function jitInstructionBarriersAt(
  analysis: JitBarrierAnalysis,
  instructionIndex: number
): readonly JitBarrier[] {
  const instruction = analysis.instructions[instructionIndex];

  if (instruction === undefined) {
    throw new Error(`missing JIT barrier instruction: ${instructionIndex}`);
  }

  return instruction.barriers;
}

export function jitOpBarriersAt(
  analysis: JitBarrierAnalysis,
  instructionIndex: number,
  opIndex: number
): readonly JitBarrier[] {
  const instruction = analysis.instructions[instructionIndex];

  if (instruction === undefined) {
    throw new Error(`missing JIT barrier instruction: ${instructionIndex}`);
  }

  const barriers = instruction.ops[opIndex];

  if (barriers === undefined) {
    throw new Error(`missing JIT barrier op: ${instructionIndex}:${opIndex}`);
  }

  return barriers;
}

export function jitOpHasBarrier(
  analysis: JitBarrierAnalysis,
  instructionIndex: number,
  opIndex: number,
  reason: JitBarrierReason
): boolean {
  return jitOpBarriersAt(analysis, instructionIndex, opIndex).some((barrier) => barrier.reason === reason);
}

export function jitOpExitsInBarriersAt(
  analysis: JitBarrierAnalysis,
  instructionIndex: number,
  opIndex: number
): readonly JitOpExitKind[] {
  return jitOpBarriersAt(analysis, instructionIndex, opIndex)
    .find((barrier) => barrier.reason === "exit")
    ?.exits ?? [];
}

function pushBarrier(
  barriers: JitBarrier[],
  instruction: JitMutableInstructionBarrierIndex,
  barrier: JitBarrier
): void {
  barriers.push(barrier);
  instruction.barriers.push(barrier);

  if (barrier.opIndex === undefined) {
    return;
  }

  const opBarriers = instruction.ops[barrier.opIndex];

  if (opBarriers === undefined) {
    throw new Error(`barrier references missing op ${barrier.instructionIndex}:${barrier.opIndex}`);
  }

  opBarriers.push(barrier);
}
