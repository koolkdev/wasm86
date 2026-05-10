import {
  conditionFlagReadMask,
  IR_ALU_FLAG_MASK,
  IR_FLAG_MASK_NONE
} from "#x86/ir/model/flag-effects.js";
import type { FlagMask } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import {
  analyzeJitBarriers,
  jitOpHasBarrier,
  jitOpPreInstructionExitReasonAt,
  type JitBarrierAnalysis
} from "#backends/wasm/jit/ir/barriers.js";

export type JitFlagLivenessOp = Readonly<{
  liveBefore: FlagMask;
  liveAfter: FlagMask;
  readMask: FlagMask;
  postExitReadMask: FlagMask;
  keptFlagSet: boolean;
}>;

export type JitFlagLivenessInstruction = Readonly<{
  liveIn: FlagMask;
  liveOut: FlagMask;
  entryReadMask: FlagMask;
  ops: readonly JitFlagLivenessOp[];
}>;

export type JitFlagLiveness = Readonly<{
  instructions: readonly JitFlagLivenessInstruction[];
}>;

export function analyzeJitFlagLiveness(
  block: JitIrBlock,
  barriers: JitBarrierAnalysis = analyzeJitBarriers(block)
): JitFlagLiveness {
  const instructions = new Array<JitFlagLivenessInstruction>(block.instructions.length);
  let live = IR_FLAG_MASK_NONE;

  for (let instructionIndex = block.instructions.length - 1; instructionIndex >= 0; instructionIndex -= 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while analyzing flag liveness: ${instructionIndex}`);
    }

    const liveOut = live;
    const ops = new Array<JitFlagLivenessOp>(instruction.ir.length);
    let entryReadMask = IR_FLAG_MASK_NONE;

    for (let opIndex = instruction.ir.length - 1; opIndex >= 0; opIndex -= 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while analyzing flag liveness: ${instructionIndex}:${opIndex}`);
      }

      if (jitOpPreInstructionExitReasonAt(barriers, instructionIndex, opIndex) !== undefined) {
        entryReadMask |= IR_ALU_FLAG_MASK;
      }

      const liveAfter = live;
      const postExitReadMask = jitOpHasBarrier(barriers, instructionIndex, opIndex, "exit")
        ? IR_ALU_FLAG_MASK
        : IR_FLAG_MASK_NONE;
      let readMask = flagReadMask(op) | postExitReadMask;
      let keptFlagSet = false;

      live |= readMask;

      if (op.op === "flags.set") {
        const producedMask = op.writtenMask | op.undefMask;

        keptFlagSet = (live & producedMask) !== 0;

        if (keptFlagSet) {
          live &= ~op.writtenMask;
        }
      }

      ops[opIndex] = {
        liveBefore: live,
        liveAfter,
        readMask,
        postExitReadMask,
        keptFlagSet
      };
    }

    live |= entryReadMask;
    instructions[instructionIndex] = {
      liveIn: live,
      liveOut,
      entryReadMask,
      ops
    };
  }

  return { instructions };
}

export function jitFlagLivenessOpAt(
  liveness: JitFlagLiveness,
  instructionIndex: number,
  opIndex: number
): JitFlagLivenessOp {
  const instruction = liveness.instructions[instructionIndex];

  if (instruction === undefined) {
    throw new Error(`missing JIT flag liveness instruction: ${instructionIndex}`);
  }

  const op = instruction.ops[opIndex];

  if (op === undefined) {
    throw new Error(`missing JIT flag liveness op: ${instructionIndex}:${opIndex}`);
  }

  return op;
}

function flagReadMask(op: JitIrOp): FlagMask {
  switch (op.op) {
    case "aluFlags.condition":
    case "flagProducer.condition":
      return conditionFlagReadMask(op.cc);
    case "flags.materialize":
    case "flags.boundary":
      return op.mask;
    default:
      return IR_FLAG_MASK_NONE;
  }
}
