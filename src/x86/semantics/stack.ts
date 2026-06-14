import type { SemanticBuildContext, SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandRef, StorageInput, ValueInput, VarRef } from "#x86/semantics/refs.js";
import { guardStorageRead, guardStorageWrite } from "./memory.js";

export function push32(s: SemanticsBuilder, context: SemanticBuildContext, value: ValueInput): void {
  const esp = s.get(s.reg("esp"));
  const nextEsp = s.i32Sub(esp, 4);
  const stack = s.mem(nextEsp);

  guardStorageWrite(s, context, stack, 32);
  s.set(stack, value);
  s.set(s.reg("esp"), nextEsp);
}

export function pop32(s: SemanticsBuilder, context: SemanticBuildContext): VarRef {
  const esp = s.get(s.reg("esp"));
  const stack = s.mem(esp);

  guardStorageRead(s, context, stack, 32);
  const value = s.get(stack);
  const nextEsp = s.i32Add(esp, 4);

  s.set(s.reg("esp"), nextEsp);
  return value;
}

export function pushSemantic(): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);

    guardStorageRead(s, context, src, 32);
    push32(s, context, s.get(src));
  };
}

export function popSemantic(): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    // SDM order: esp is incremented before the destination EA is computed,
    // so an esp-based destination sees the new esp.
    const value = pop32(s, context);

    s.set(popTargetStorage(s, context, dst), value);
  };
}

export function leaveSemantic(): SemanticTemplate {
  return (s, context) => {
    const frame = s.get(s.reg("ebp"));
    const savedFrameStorage = s.mem(frame);

    guardStorageRead(s, context, savedFrameStorage, 32);
    const savedFrame = s.get(savedFrameStorage);
    const nextEsp = s.i32Add(frame, 4);

    s.set(s.reg("esp"), nextEsp);
    s.set(s.reg("ebp"), savedFrame);
  };
}

function popTargetStorage(s: SemanticsBuilder, context: SemanticBuildContext, dst: OperandRef): StorageInput {
  if (context.operandInfo(dst).storage === "mem") {
    const target = s.mem(s.address(dst));

    guardStorageWrite(s, context, target, 32);
    return target;
  }

  guardStorageWrite(s, context, dst, 32);
  return dst;
}
