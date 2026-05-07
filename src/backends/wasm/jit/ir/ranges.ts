import type { Reg32 } from "#x86/isa/types.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { JitIrBlock } from "#backends/wasm/jit/ir/types.js";
import {
  walkJitIrOpsBetween,
  type JitIrLocation
} from "#backends/wasm/jit/ir/walk.js";
import { jitStorageReg } from "#backends/wasm/jit/ir/values.js";

export function jitRegClobberedBetween(
  block: JitIrBlock,
  reg: Reg32,
  after: JitIrLocation,
  before: JitIrLocation
): boolean {
  let clobbered = false;

  walkJitIrOpsBetween(block, after, before, (instruction, op) => {
    if (op.op === "set" && jitStorageReg(op.target, instruction.operands) === reg) {
      clobbered = true;
    }
  });

  return clobbered;
}

export function findJitRegWritebackBetween(
  block: JitIrBlock,
  value: ValueRef,
  after: JitIrLocation,
  before: JitIrLocation
): Readonly<{ reg: Reg32; location: JitIrLocation }> | undefined {
  let writeback: Readonly<{ reg: Reg32; location: JitIrLocation }> | undefined;

  walkJitIrOpsBetween(block, after, before, (instruction, op, location) => {
    if (
      writeback !== undefined ||
      op.op !== "set" ||
      op.role === "registerMaterialization" ||
      !sameValueRef(op.value, value)
    ) {
      return;
    }

    const reg = jitStorageReg(op.target, instruction.operands);

    if (reg !== undefined) {
      writeback = { reg, location };
    }
  });

  return writeback;
}

function sameValueRef(a: ValueRef, b: ValueRef): boolean {
  switch (a.kind) {
    case "var":
      return b.kind === "var" && a.id === b.id;
    case "const":
      return b.kind === "const" && a.type === b.type && a.value === b.value;
    case "nextEip":
      return b.kind === "nextEip";
  }
}
