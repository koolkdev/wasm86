import type { Reg32 } from "#x86/isa/types.js";
import type { ValueRef, VarRef } from "#x86/ir/model/types.js";
import { jitIrOpDst } from "#backends/wasm/jit/ir/semantics.js";
import type { JitIrBlockInstruction, JitIrOp } from "#backends/wasm/jit/ir/types.js";
import type { JitLegacyRewritableValue, JitRegValue } from "#backends/wasm/jit/ir/values.js";
import { jitValueIsSymbolicReg } from "#backends/wasm/jit/ir/values.js";
import { JitValueTracker } from "#backends/wasm/jit/ir/value-tracker.js";

export type JitInstructionRewrite = {
  ops: JitIrOp[];
  values: JitValueTracker;
  nextVarId: number;
};

export type JitInstructionRewriteOp = Readonly<{
  instruction: JitIrBlockInstruction;
  instructionIndex: number;
  op: JitIrOp;
  opIndex: number;
  rewrite: JitInstructionRewrite;
}>;

export function rewriteJitIrInstruction(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  context: string,
  rewriteOp: (entry: JitInstructionRewriteOp) => void
): JitIrBlockInstruction {
  const rewrite = createJitInstructionRewrite(instruction);

  rewriteJitIrInstructionInto(instruction, instructionIndex, context, rewrite, rewriteOp);
  return {
    ...instruction,
    ir: rewrite.ops
  };
}

export function rewriteJitIrInstructionInto(
  instruction: JitIrBlockInstruction,
  instructionIndex: number,
  context: string,
  rewrite: JitInstructionRewrite,
  rewriteOp: (entry: JitInstructionRewriteOp) => void
): void {
  for (let opIndex = 0; opIndex < instruction.ir.length; opIndex += 1) {
    const op = instruction.ir[opIndex];

    if (op === undefined) {
      throw new Error(`missing JIT IR op while ${context}: ${instructionIndex}:${opIndex}`);
    }

    rewriteOp({ instruction, instructionIndex, op, opIndex, rewrite });
  }
}

export function createJitInstructionRewrite(
  instruction: JitIrBlockInstruction,
  values: JitValueTracker = new JitValueTracker()
): JitInstructionRewrite {
  return {
    ops: [],
    values,
    nextVarId: nextInstructionVarId(instruction)
  };
}

export function materializeJitRegisterValue(
  rewrite: JitInstructionRewrite,
  reg: Reg32,
  value: JitLegacyRewritableValue
): boolean {
  return materializeJitRegisterValues(rewrite, [{ reg, value }]) !== 0;
}

export function materializeJitRegisterValues(
  rewrite: JitInstructionRewrite,
  values: readonly Readonly<{ reg: Reg32; value: JitLegacyRewritableValue }>[]
): number {
  const refs = values.flatMap(({ reg, value }) =>
    jitValueIsSymbolicReg(value, reg)
      ? []
      : [{ reg, value: emitRewritableJitValueRef(rewrite, value) }]
  );

  for (const { reg, value } of refs) {
    rewrite.ops.push({
      op: "set",
      role: "registerMaterialization",
      target: { kind: "reg", reg },
      value
    });
  }

  return refs.length;
}

function emitJitValueGet(
  rewrite: JitInstructionRewrite,
  value: JitRegValue
): ValueRef {
  const dst = allocVar(rewrite);

  rewrite.ops.push({
    op: "get",
    dst,
    source: { kind: "reg", reg: value.reg },
    role: "symbolicRead"
  });
  rewrite.values.record(dst.id, value);
  return dst;
}

export function emitRewritableJitValueRef(
  rewrite: JitInstructionRewrite,
  value: JitLegacyRewritableValue
): ValueRef {
  const existingValue = rewrite.values.refFor(value);

  if (existingValue !== undefined) {
    return existingValue;
  }

  switch (value.kind) {
    case "value.binary": {
      const dst = allocVar(rewrite);

      rewrite.ops.push({
        op: "value.binary",
        type: value.type,
        operator: value.operator,
        dst,
        a: emitRewritableJitValueRef(rewrite, value.a),
        b: emitRewritableJitValueRef(rewrite, value.b)
      });
      rewrite.values.record(dst.id, value);
      return dst;
    }
    case "value.unary": {
      const dst = allocVar(rewrite);

      rewrite.ops.push({
        op: "value.unary",
        type: value.type,
        operator: value.operator,
        dst,
        value: emitRewritableJitValueRef(rewrite, value.value)
      });
      rewrite.values.record(dst.id, value);
      return dst;
    }
    case "value.select": {
      const dst = allocVar(rewrite);

      rewrite.ops.push({
        op: "value.select",
        type: value.type,
        dst,
        condition: emitRewritableJitValueRef(rewrite, value.condition),
        whenTrue: emitRewritableJitValueRef(rewrite, value.whenTrue),
        whenFalse: emitRewritableJitValueRef(rewrite, value.whenFalse)
      });
      rewrite.values.record(dst.id, value);
      return dst;
    }
    case "const":
      return { kind: "const", type: value.type, value: value.value };
    case "reg":
      return emitJitValueGet(rewrite, value);
  }
}

export function assignRewritableJitValue(
  rewrite: JitInstructionRewrite,
  dst: VarRef,
  value: JitLegacyRewritableValue
): void {
  switch (value.kind) {
    case "value.binary":
      rewrite.ops.push({
        op: "value.binary",
        type: value.type,
        operator: value.operator,
        dst,
        a: emitRewritableJitValueRef(rewrite, value.a),
        b: emitRewritableJitValueRef(rewrite, value.b)
      });
      return;
    case "value.unary":
      rewrite.ops.push({
        op: "value.unary",
        type: value.type,
        operator: value.operator,
        dst,
        value: emitRewritableJitValueRef(rewrite, value.value)
      });
      return;
    case "value.select":
      rewrite.ops.push({
        op: "value.select",
        type: value.type,
        dst,
        condition: emitRewritableJitValueRef(rewrite, value.condition),
        whenTrue: emitRewritableJitValueRef(rewrite, value.whenTrue),
        whenFalse: emitRewritableJitValueRef(rewrite, value.whenFalse)
      });
      return;
    case "const":
      rewrite.ops.push({ op: "value.const", type: value.type, dst, value: value.value });
      return;
    case "reg":
      rewrite.ops.push({
        op: "get",
        dst,
        source: { kind: "reg", reg: value.reg },
        role: "symbolicRead"
      });
      return;
  }
}

function allocVar(rewrite: JitInstructionRewrite): VarRef {
  const varRef = { kind: "var" as const, id: rewrite.nextVarId };

  rewrite.nextVarId += 1;
  return varRef;
}

function nextInstructionVarId(instruction: JitIrBlockInstruction): number {
  let nextVarId = 0;

  for (const op of instruction.ir) {
    const dst = jitIrOpDst(op);

    if (dst !== undefined) {
      nextVarId = Math.max(nextVarId, dst.id + 1);
    }
  }

  return nextVarId;
}
