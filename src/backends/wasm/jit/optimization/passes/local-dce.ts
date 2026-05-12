import {
  irOpDst,
  irOpResult,
  visitIrOpValueRefs
} from "#x86/ir/model/op-semantics.js";
import type { IrOp } from "#x86/ir/model/types.js";
import type { JitIrBlock, JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import {
  analyzeJitBarriers,
  jitOpPreInstructionExitReasonAt,
  type JitBarrierAnalysis
} from "#backends/wasm/jit/ir/barriers.js";
import type { JitOptimizationPass } from "#backends/wasm/jit/optimization/pass.js";

export type JitLocalDce = Readonly<{
  removedOpCount: number;
}>;

export const localDcePass = {
  name: "localDce",
  run(block) {
    const result = pruneDeadJitLocalValues(block);

    return {
      block: result.block,
      changed: result.localDce.removedOpCount !== 0,
      stats: result.localDce
    };
  }
} satisfies JitOptimizationPass<"localDce">;

export function pruneDeadJitLocalValues(
  block: JitIrBlock,
  barriers: JitBarrierAnalysis = analyzeJitBarriers(block)
): Readonly<{ block: JitIrBlock; localDce: JitLocalDce }> {
  let removedOpCount = 0;
  const instructions = block.instructions.map((instruction, instructionIndex) => {
    const pruned = pruneInstructionDeadLocalValues(instruction, instructionIndex, barriers);

    removedOpCount += pruned.removedOpCount;
    return pruned.instruction;
  });

  return {
    block: { instructions },
    localDce: { removedOpCount }
  };
}

function pruneInstructionDeadLocalValues(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  barriers: JitBarrierAnalysis
): Readonly<{ instruction: JitIrBlockInstruction; removedOpCount: number }> {
  const liveVars = new Set<number>();
  const ops: IrOp[] = [];
  let removedOpCount = 0;

  for (let opIndex = instruction.ir.length - 1; opIndex >= 0; opIndex -= 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while pruning dead local values: ${instructionIndex}:${opIndex}`);
    }

    const dst = irOpDst(op);

    if (dst !== undefined && !liveVars.has(dst.id) && canDropUnusedResult(op, instructionIndex, opIndex, barriers)) {
      removedOpCount += 1;
      continue;
    }

    if (dst !== undefined) {
      liveVars.delete(dst.id);
    }

    visitIrOpValueRefs(op, (value) => {
      if (value.kind === "var") {
        liveVars.add(value.id);
      }
    });
    ops.push(op);
  }

  ops.reverse();
  return {
    instruction: {
      ...instruction,
      ir: ops
    },
    removedOpCount
  };
}

function canDropUnusedResult(
  op: IrOp,
  instructionIndex: number,
  opIndex: number,
  barriers: JitBarrierAnalysis
): boolean {
  const result = irOpResult(op);

  if (result.kind === "none") {
    return false;
  }

  switch (result.sideEffect) {
    case "none":
      return true;
    case "storageRead":
      return jitOpPreInstructionExitReasonAt(barriers, instructionIndex, opIndex) === undefined;
  }
}
