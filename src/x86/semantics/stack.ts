import type { SemanticBuildContext, SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandRef, StorageInput, Value, ValueInput } from "#x86/semantics/refs.js";
import { x86EflagsBitOffset, x86Flags } from "#x86/flags.js";
import type { OperandWidth } from "#x86/types.js";
import { guardStorageRead, guardStorageWrite } from "./memory.js";

export type StackOperandWidth = Extract<OperandWidth, 16 | 32>;

export function pushStack(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  value: ValueInput
): void {
  const esp = s.get(s.reg("esp"));
  const nextEsp = s.i32Sub(esp, s.const32(stackByteLength(width)));
  const stack = s.mem(nextEsp);

  guardStorageWrite(s, context, stack, width);
  s.set(stack, value, width);
  s.set(s.reg("esp"), nextEsp);
}

export function popStack(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  width: StackOperandWidth
): Value {
  const esp = s.get(s.reg("esp"));
  const stack = s.mem(esp);

  guardStorageRead(s, context, stack, width);
  const value = s.get(stack, width);
  const nextEsp = s.i32Add(esp, s.const32(stackByteLength(width)));

  s.set(s.reg("esp"), nextEsp);
  return value;
}

export function pushSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const src = s.operand(0);

    guardStorageRead(s, context, src, width);
    pushStack(s, context, width, s.get(src, width));
  };
}

export function pushfdSemantic(): SemanticTemplate {
  return (s, context) => {
    // Reserved bit 1 and the user-mode IF image bit are set.
    let image: Value = s.const32(0x202);

    for (const flag of x86Flags) {
      const bit = s.readFlag(flag);
      const offset = x86EflagsBitOffset[flag];

      image = s.i32Or(image, offset === 0 ? bit : s.i32Shl(bit, s.const32(offset)));
    }

    pushStack(s, context, 32, image);
  };
}

export function popfdSemantic(): SemanticTemplate {
  return (s, context) => {
    const image = popStack(s, context, 32);
    const one = s.const32(1);

    for (const flag of x86Flags) {
      const offset = x86EflagsBitOffset[flag];
      const shifted = offset === 0 ? image : s.i32ShrU(image, s.const32(offset));

      s.writeFlag(flag, s.i32And(shifted, one));
    }
  };
}

export function popSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, context) => {
    const dst = s.operand(0);
    // SDM order: esp is incremented before the destination EA is computed,
    // so an esp-based destination sees the new esp.
    const value = popStack(s, context, width);

    s.set(popTargetStorage(s, context, width, dst), value, width);
  };
}

export function leaveSemantic(): SemanticTemplate {
  return (s, context) => {
    const frame = s.get(s.reg("ebp"));
    const savedFrameStorage = s.mem(frame);

    guardStorageRead(s, context, savedFrameStorage, 32);
    const savedFrame = s.get(savedFrameStorage);
    const nextEsp = s.i32Add(frame, s.const32(4));

    s.set(s.reg("esp"), nextEsp);
    s.set(s.reg("ebp"), savedFrame);
  };
}

function popTargetStorage(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  dst: OperandRef
): StorageInput {
  if (context.operandInfo(dst).storage === "mem") {
    const target = s.mem(s.address(dst));

    guardStorageWrite(s, context, target, width);
    return target;
  }

  guardStorageWrite(s, context, dst, width);
  return dst;
}

function stackByteLength(width: StackOperandWidth): 2 | 4 {
  return width === 16 ? 2 : 4;
}
