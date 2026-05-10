import { strictEqual } from "node:assert";

import type { Reg32 } from "#x86/isa/types.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import type { ConditionCode, IrOp, ValueRef, VarRef } from "#x86/ir/model/types.js";
import type { ExitReason as ExitReasonValue } from "#backends/wasm/exit.js";
import type { JitExitPoint } from "#backends/wasm/jit/codegen/plan/types.js";
import type { JitFlagOwnerMask } from "#backends/wasm/jit/optimization/analyses/flag-owners.js";
import type {
  JitIrBlock,
  JitIrBody,
  JitIrBlockInstruction
} from "#backends/wasm/jit/ir/types.js";

export const startAddress = 0x1000;

export function onlyExit(exits: readonly JitExitPoint[], reason: ExitReasonValue): JitExitPoint {
  const matches = exits.filter((entry) => entry.exitReason === reason);

  strictEqual(matches.length, 1);
  return matches[0]!;
}

export function logic32LocalConditionBlock(cc: ConditionCode): JitIrBlock {
  return {
    instructions: [
      syntheticInstruction([
        { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
        { op: "value.binary", type: "i32", operator: "and", dst: v(1), a: v(0), b: c32(0xff) },
        createIrFlagSetOp("logic", { result: v(1) }),
        { op: "set", target: { kind: "reg", reg: "eax" }, value: v(1) },
        { op: "next" }
      ], 0),
      syntheticInstruction([
        { op: "flags.condition", dst: v(0), cc },
        ...selectSet(v(0), v(1)),
        { op: "next" }
      ], 1)
    ]
  };
}

export function selectSet(
  condition: ValueRef,
  dst: VarRef,
  target: Reg32 = "ecx",
  whenTrue: ValueRef = c32(1),
  whenFalse: ValueRef = c32(0)
): readonly IrOp[] {
  return [
    { op: "value.select", type: "i32", dst, condition, whenTrue, whenFalse },
    { op: "set", target: { kind: "reg", reg: target }, value: dst }
  ];
}

export function syntheticInstruction(
  ir: JitIrBody,
  index = 0,
  nextMode: JitIrBlock["instructions"][number]["nextMode"] = "continue"
): JitIrBlock["instructions"][number] {
  return {
    instructionId: `synthetic.${index}`,
    eip: startAddress + index,
    nextEip: startAddress + index + 1,
    nextMode,
    operands: [],
    ir
  };
}

export function setTargetRegs(
  instructions: readonly JitIrBlockInstruction[]
): readonly Reg32[] {
  return instructions.flatMap((instruction) =>
    instructionOps(instruction).flatMap((op) => {
      if (op.op !== "set") {
        return [];
      }

      switch (op.target.kind) {
        case "reg":
          return [op.target.reg];
        case "operand": {
          const binding = instruction.operands[op.target.index];

          return binding?.kind === "static.reg" ? [binding.alias.base] : [];
        }
        case "mem":
          return [];
      }
    })
  );
}

function instructionOps(instruction: JitIrBlockInstruction): JitIrBody {
  return instruction.ir;
}

export function flagOwnerSummary(owners: readonly JitFlagOwnerMask[]): readonly object[] {
  return owners.map(({ mask, owner }) => {
    switch (owner.kind) {
      case "producer":
        return { mask, kind: owner.kind, sourceId: owner.source.id, producer: owner.source.producer };
      case "incoming":
      case "materialized":
        return { mask, kind: owner.kind };
    }
  });
}

export function v(id: number): VarRef {
  return { kind: "var", id };
}

export function c32(value: number): ValueRef {
  return { kind: "const", type: "i32", value };
}
