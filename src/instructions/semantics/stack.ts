import { i32, type Integer } from "#compiler/function/values.js";
import type { SemanticsBuilder, InstructionSemantics } from "#instructions/semantics/builder.js";
import { x86EflagsBitOffset, x86Flags, type X86Flag } from "#core/flags/definitions.js";
import type { OperandWidth, Reg16, Reg32 } from "#core/types.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";

export type StackOperandWidth = Extract<OperandWidth, 16 | 32>;

const x86Low16Flags = x86Flags.filter((flag) => x86EflagsBitOffset[flag] < 16);
const pushadRegisters = [
  "eax",
  "ecx",
  "edx",
  "ebx",
  "esp",
  "ebp",
  "esi",
  "edi"
] as const satisfies readonly Reg32[];
const pushaRegisters = [
  "ax",
  "cx",
  "dx",
  "bx",
  "sp",
  "bp",
  "si",
  "di"
] as const satisfies readonly Reg16[];
const popadCells = [
  ["edi", 0],
  ["esi", 4],
  ["ebp", 8],
  ["ebx", 16],
  ["edx", 20],
  ["ecx", 24],
  ["eax", 28]
] as const satisfies readonly (readonly [Reg32, number])[];
const popaCells = [
  ["di", 0],
  ["si", 2],
  ["bp", 4],
  ["bx", 8],
  ["dx", 10],
  ["cx", 12],
  ["ax", 14]
] as const satisfies readonly (readonly [Reg16, number])[];

export function pushStack<Width extends StackOperandWidth>(
  s: SemanticsBuilder,
  value: Integer<Width>
): void {
  const esp = s.read(s.reg("esp"));
  const nextEsp = esp.sub(stackByteLength(value.width));
  const stack = s.memory.reference("ss", nextEsp);

  s.memory.write(stack, value);
  s.write(s.reg("esp"), nextEsp);
}

export function popStack<Width extends StackOperandWidth>(
  s: SemanticsBuilder,
  width: Width
): Integer<Width> {
  const esp = s.read(s.reg("esp"));
  const stack = s.memory.reference("ss", esp);
  const value = s.memory.read(stack, width);
  const nextEsp = esp.add(stackByteLength(width));

  s.write(s.reg("esp"), nextEsp);
  return value;
}

export function pushSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const src = s.operand(0);

    pushStack(s, s.read(src, width));
  };
}

export function pushfdSemantic(): InstructionSemantics {
  return (s) => pushFlags(s, 32, x86Flags);
}

export function pushfSemantic(): InstructionSemantics {
  return (s) => pushFlags(s, 16, x86Low16Flags);
}

export function popfdSemantic(): InstructionSemantics {
  return (s) => popFlags(s, 32, x86Flags);
}

export function popfSemantic(): InstructionSemantics {
  return (s) => popFlags(s, 16, x86Low16Flags);
}

export function pushadSemantic(): InstructionSemantics {
  return (s) => pushAll(s, 32);
}

export function pushaSemantic(): InstructionSemantics {
  return (s) => pushAll(s, 16);
}

export function popadSemantic(): InstructionSemantics {
  return (s) => popAll(s, 32);
}

export function popaSemantic(): InstructionSemantics {
  return (s) => popAll(s, 16);
}

function pushAll(s: SemanticsBuilder, width: StackOperandWidth): void {
  const esp = s.read(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const nextEsp = esp.sub(totalBytes);
  const access = s.memory.guard({
    reference: s.memory.reference("ss", nextEsp),
    byteLength: i32(totalBytes),
    intent: "write"
  });

  if (width === 32) {
    storeValues(pushadRegisters.map((reg) => (reg === "esp" ? esp : s.read(s.reg(reg)))));
  } else {
    storeValues(
      pushaRegisters.map((reg) => (reg === "sp" ? esp.truncate(16) : s.read(s.reg(reg))))
    );
  }
  s.write(s.reg("esp"), nextEsp);

  function storeValues<Width extends StackOperandWidth>(values: readonly Integer<Width>[]): void {
    values.forEach((value, index) => {
      const byteOffset = totalBytes - cellBytes * (index + 1);

      s.memory.store(access, value, i32(byteOffset));
    });
  }
}

function popAll(s: SemanticsBuilder, width: StackOperandWidth): void {
  const esp = s.read(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const access = s.memory.guard({
    reference: s.memory.reference("ss", esp),
    byteLength: i32(totalBytes),
    intent: "read"
  });

  const nextEsp = esp.add(totalBytes);

  if (width === 32) {
    for (const [reg, offset] of popadCells) {
      const value = s.memory.load(access, 32, i32(offset));

      s.write(s.reg(reg), value);
    }
  } else {
    for (const [reg, offset] of popaCells) {
      const value = s.memory.load(access, 16, i32(offset));

      s.write(s.reg(reg), value);
    }
  }

  s.write(s.reg("esp"), nextEsp);
}

function pushFlags(s: SemanticsBuilder, width: StackOperandWidth, flags: readonly X86Flag[]): void {
  // Reserved bit 1 and the user-mode IF image bit are set.
  pushStack(s, buildFlagImage(s, flags, 0x202).truncate(width));
}

function popFlags(s: SemanticsBuilder, width: StackOperandWidth, flags: readonly X86Flag[]): void {
  const image = popStack(s, width);

  writeFlagsFromImage(s, flags, image);
}

export function popSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    // SDM order: esp is incremented before the destination EA is computed,
    // so an esp-based destination sees the new esp.
    const value = popStack(s, width);

    s.write(dst, value);
  };
}

export function popSegmentSemantic(width: StackOperandWidth = 32): InstructionSemantics {
  return (s) => {
    const dst = s.operand(0);
    const value = popStack(s, width);

    s.write(dst, value.truncate(16));
  };
}

export function leaveSemantic(): InstructionSemantics {
  return (s) => {
    const frame = s.read(s.reg("ebp"));
    const savedFrame = s.memory.read(s.memory.reference("ss", frame), 32);
    const nextEsp = frame.add(4);

    s.write(s.reg("esp"), nextEsp);
    s.write(s.reg("ebp"), savedFrame);
  };
}

function stackByteLength(width: StackOperandWidth): 2 | 4 {
  return width === 16 ? 2 : 4;
}
