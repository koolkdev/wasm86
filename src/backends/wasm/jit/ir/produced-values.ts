import type { IrOp, StorageRef } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";
import type { JitIrBlockInstruction } from "#backends/wasm/jit/ir/types.js";
import { walkJitIrInstructionOps, type JitIrLocation } from "#backends/wasm/jit/ir/walk.js";
import { jitProducedValue } from "#backends/wasm/jit/ir/value-builders.js";
import type {
  JitProducedValue,
  JitProducedValueId
} from "#backends/wasm/jit/ir/value-types.js";

export function indexProducedValuesByVarIdForInstruction(
  instruction: JitIrBlockInstruction,
  instructionIndex: number
): ReadonlyMap<number, JitProducedValue> {
  const producedValues = new Map<number, JitProducedValue>();

  walkJitIrInstructionOps(
    instruction,
    instructionIndex,
    (_instruction, op, location) => {
      if (op.op !== "get") {
        return;
      }

      const producedValue = jitProducedValueForEffectfulRead(instruction, location, op);

      if (producedValue !== undefined) {
        producedValues.set(op.dst.id, producedValue);
      }
    },
    "indexing JIT produced values"
  );

  return producedValues;
}

export function jitProducedValueForEffectfulRead(
  instruction: Pick<JitIrBlockInstruction, "instructionId" | "operands">,
  location: JitIrLocation,
  op: Extract<IrOp, { op: "get" }>
): JitProducedValue | undefined {
  return jitGetReadsEffectfulSource(instruction, op)
    ? jitProducedValue(jitProducedValueIdForEffectfulRead(instruction, location, op), "i32")
    : undefined;
}

export function jitProducedValueIdForEffectfulRead(
  instruction: Pick<JitIrBlockInstruction, "instructionId">,
  location: JitIrLocation,
  op: Extract<IrOp, { op: "get" }>
): JitProducedValueId {
  return `load#${instruction.instructionId}:${location.instructionIndex}:${location.opIndex}:${op.dst.id}`;
}

export function jitGetReadsEffectfulSource(
  instruction: Pick<JitIrBlockInstruction, "operands">,
  op: Extract<IrOp, { op: "get" }>
): boolean {
  return jitStorageReadIsEffectful(op.source, instruction.operands);
}

export function jitStorageReadIsEffectful(
  storage: StorageRef,
  operands: readonly JitOperandBinding[]
): boolean {
  switch (storage.kind) {
    case "mem":
      return true;
    case "operand":
      return operands[storage.index]?.kind === "static.mem";
    case "reg":
      return false;
  }
}
