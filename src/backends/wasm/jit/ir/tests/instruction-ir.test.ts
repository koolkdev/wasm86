import { strictEqual } from "node:assert";
import { test } from "node:test";

import { bindInstructionIr } from "#backends/wasm/jit/ir/instruction-ir.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import { IrBlockBuilder } from "#x86/ir/build/block.js";
import { createIrVarAllocator, operand } from "#x86/ir/build/builder.js";
import type { IrBlock, IrOp } from "#x86/ir/model/types.js";

const espMemoryOperand: JitOperandBinding = {
  kind: "static.mem",
  ea: { kind: "mem", accessWidth: 32, base: "esp", scale: 1, disp: 0 }
};

test("bindInstructionIr resolves separate operand calls independently", () => {
  const ir = instructionIr((s) => {
    s.get(s.operand(0));
    s.set(s.reg("esp"), 0x2000);
    s.get(s.operand(0));
    s.next();
  });

  strictEqual(espAddressReadCount(bind(ir)), 2);
});

test("bindInstructionIr reuses address resolution for the same operand ref", () => {
  const ir = instructionIr((s) => {
    const source = s.operand(0);

    s.get(source);
    s.set(s.reg("esp"), 0x2000);
    s.get(source);
    s.next();
  });

  strictEqual(espAddressReadCount(bind(ir)), 1);
});

function instructionIr(emit: Parameters<IrBlockBuilder["appendInstruction"]>[0]["semantics"]): IrBlock {
  const builder = new IrBlockBuilder();

  builder.appendInstruction({
    semantics: emit,
    operands: [operand(0)]
  });
  return builder.build();
}

function bind(ir: IrBlock): readonly IrOp[] {
  return bindInstructionIr({
    ir,
    operands: [espMemoryOperand],
    nextEip: 0x1001,
    allocator: createIrVarAllocator()
  });
}

function espAddressReadCount(ir: readonly IrOp[]): number {
  return ir.filter((op) =>
    op.op === "get" &&
    op.source.kind === "reg" &&
    op.source.reg === "esp"
  ).length;
}
