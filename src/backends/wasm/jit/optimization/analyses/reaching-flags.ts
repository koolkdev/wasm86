import {
  conditionFlagReadMask,
  IR_ALU_FLAG_MASK
} from "#x86/ir/model/flag-effects.js";
import type { ConditionCode, FlagMask, IrOp } from "#x86/ir/model/types.js";
import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  analyzeJitBarriers,
  jitOpBarriersAt,
  jitOpHasBarrier,
  type JitBarrierAnalysis
} from "#backends/wasm/jit/ir/barriers.js";
import { jitConditionUseAt } from "#backends/wasm/jit/ir/effects.js";
import { jitStorageRegisterAccess } from "#backends/wasm/jit/ir/register-prefix-values.js";
import { JitValueTracker } from "#backends/wasm/jit/ir/value-tracker.js";
import { JitRegisterValues } from "#backends/wasm/jit/optimization/registers/values.js";
import {
  JitFlagOwners,
  type JitFlagOwner,
  type JitFlagOwnerMask
} from "#backends/wasm/jit/optimization/analyses/flag-owners.js";
import { buildJitFlagSource, type JitFlagSource } from "#backends/wasm/jit/optimization/analyses/flag-sources.js";
import type { JitConditionUse } from "#backends/wasm/jit/ir/condition-uses.js";

export type {
  JitFlagOwner,
  JitFlagOwnerMask,
  JitFlagSource
};

export type JitReachingFlagReadReason =
  | "condition"
  | "preInstructionExit"
  | "exit";

export type JitReachingFlagRead = Readonly<{
  instructionIndex: number;
  opIndex: number;
  reason: JitReachingFlagReadReason;
  requiredMask: FlagMask;
  owners: readonly JitFlagOwnerMask[];
  cc?: ConditionCode;
  conditionUse?: JitConditionUse;
  exitReason?: ExitReasonValue;
}>;

export type JitReachingFlags = Readonly<{
  sources: readonly JitFlagSource[];
  reads: readonly JitReachingFlagRead[];
  finalOwners: readonly JitFlagOwnerMask[];
}>;

export function analyzeJitReachingFlags(
  block: JitIrBlock,
  barriers: JitBarrierAnalysis = analyzeJitBarriers(block)
): JitReachingFlags {
  const owners = JitFlagOwners.incoming();
  const registers = new JitRegisterValues();
  const sources: JitFlagSource[] = [];
  const reads: JitReachingFlagRead[] = [];
  let nextSourceId = 0;

  for (let instructionIndex = 0; instructionIndex < block.instructions.length; instructionIndex += 1) {
    const instruction = block.instructions[instructionIndex];

    if (instruction === undefined) {
      throw new Error(`missing JIT instruction while analyzing reaching flags: ${instructionIndex}`);
    }

    const values = new JitValueTracker();
    const instructionEntryOwners = owners.clone();

    for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
      const op = instruction.ir[opIndex];

      if (op === undefined) {
        throw new Error(`missing JIT IR op while analyzing reaching flags: ${instructionIndex}:${opIndex}`);
      }

      analyzeOp(instruction, instructionIndex, op, opIndex, values, instructionEntryOwners);
    }
  }

  return {
    sources,
    reads,
    finalOwners: owners.forMask(IR_ALU_FLAG_MASK)
  };

  function analyzeOp(
    instruction: JitIrBlockInstruction,
    instructionIndex: number,
    op: IrOp,
    opIndex: number,
    values: JitValueTracker,
    instructionEntryOwners: JitFlagOwners
  ): void {
    for (const barrier of jitOpBarriersAt(barriers, instructionIndex, opIndex)) {
      if (barrier.reason === "preInstructionExit") {
        const read = {
          instructionIndex,
          opIndex,
          reason: "preInstructionExit" as const,
          requiredMask: IR_ALU_FLAG_MASK
        };

        recordRead({
          ...read,
          ...(barrier.exitReason === undefined ? {} : { exitReason: barrier.exitReason })
        }, instructionEntryOwners);
      }
    }

    if (values.recordOp(op, instruction, registers.trackedRegisterValues)) {
      return;
    }

    switch (op.op) {
      case "set":
        recordRegisterSet(op, instruction, values);
        break;
      case "flags.set": {
        const source = buildJitFlagSource(nextSourceId, instructionIndex, opIndex, op, values);

        nextSourceId += 1;
        sources.push(source);
        owners.recordSource(source);
        break;
      }
      case "flags.condition": {
        const conditionUse = jitConditionUseAt(barriers.effects, instructionIndex, opIndex);

        if (conditionUse !== undefined) {
          recordRead({
            instructionIndex,
            opIndex,
            reason: "condition",
            requiredMask: conditionFlagReadMask(op.cc),
            cc: op.cc,
            conditionUse
          });
        }
        break;
      }
      default:
        break;
    }

    if (jitOpHasBarrier(barriers, instructionIndex, opIndex, "exit")) {
      recordRead({
        instructionIndex,
        opIndex,
        reason: "exit",
        requiredMask: IR_ALU_FLAG_MASK
      });
    }
  }

  function recordRead(
    read: Omit<JitReachingFlagRead, "owners">,
    readOwners: JitFlagOwners = owners
  ): void {
    if (read.requiredMask === 0) {
      return;
    }

    reads.push({
      ...read,
      owners: readOwners.forMask(read.requiredMask)
    });
  }

  function recordRegisterSet(
    op: Extract<IrOp, { op: "set" }>,
    instruction: JitIrBlockInstruction,
    values: JitValueTracker
  ): void {
    const access = jitStorageRegisterAccess(op.target, instruction.operands, op.accessWidth ?? 32);

    if (access === undefined) {
      return;
    }

    const value = values.valueFor(op.value);

    if (value === undefined) {
      registers.delete(access.reg);
    } else {
      registers.write(access.reg, access.width, access.bitOffset, value);
    }
  }

}

export function reachingFlagReadAt(
  analysis: JitReachingFlags,
  instructionIndex: number,
  opIndex: number
): JitReachingFlagRead | undefined {
  return analysis.reads.find((read) =>
    read.instructionIndex === instructionIndex && read.opIndex === opIndex
  );
}

export function singleReachingFlagProducer(read: JitReachingFlagRead): JitFlagSource | undefined {
  let source: JitFlagSource | undefined;

  for (const { owner } of read.owners) {
    if (owner.kind !== "producer") {
      return undefined;
    }

    if (source === undefined) {
      source = owner.source;
    } else if (source !== owner.source) {
      return undefined;
    }
  }

  return source;
}
