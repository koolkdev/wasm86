import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { SemanticsBuilder, SemanticTemplate } from "#core/semantics/builder.js";
import type { Value, ValueInput } from "#core/semantics/refs.js";
import { x86EflagsBitOffset, x86Flags, type X86Flag } from "#core/flags/definitions.js";
import type { OperandWidth, Reg16, Reg32 } from "#core/types.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";

export type StackOperandWidth = Extract<OperandWidth, 16 | 32>;

const x86Low16Flags = x86Flags.filter((flag) => x86EflagsBitOffset[flag] < 16);
const pushadRegisters = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"] as const satisfies readonly Reg32[];
const pushaRegisters = ["ax", "cx", "dx", "bx", "sp", "bp", "si", "di"] as const satisfies readonly Reg16[];
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

export function pushStack(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: StackOperandWidth,
  value: ValueInput
): void {
  const esp = s.read(s.reg("esp"), { width: 32 });
  const nextEsp = v.binary("sub", esp, v.const(stackByteLength(width)));
  const stack = s.memory.access({
    reference: s.memory.reference("ss", nextEsp),
    byteLength: v.const(stackByteLength(width)),
    intent: "write"
  });

  s.memory.write(stack, { width, value });
  s.write(s.reg("esp"), nextEsp, { width: 32 });
}

export function popStack(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: StackOperandWidth
): Value {
  const esp = s.read(s.reg("esp"), { width: 32 });
  const stack = s.memory.access({
    reference: s.memory.reference("ss", esp),
    byteLength: v.const(stackByteLength(width)),
    intent: "read"
  });

  const value = s.memory.read(stack, { width });
  const nextEsp = v.binary("add", esp, v.const(stackByteLength(width)));

  s.write(s.reg("esp"), nextEsp, { width: 32 });
  return value;
}

export function pushSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const src = s.operand(0);

    pushStack(s, v, width, s.read(src, { width }));
  };
}

export function pushfdSemantic(): SemanticTemplate {
  return (s, v) => {
    pushFlags(s, v, 32, x86Flags);
  };
}

export function pushfSemantic(): SemanticTemplate {
  return (s, v) => {
    pushFlags(s, v, 16, x86Low16Flags);
  };
}

export function popfdSemantic(): SemanticTemplate {
  return (s, v) => {
    popFlags(s, v, 32, x86Flags);
  };
}

export function popfSemantic(): SemanticTemplate {
  return (s, v) => {
    popFlags(s, v, 16, x86Low16Flags);
  };
}

export function pushadSemantic(): SemanticTemplate {
  return (s, v) => {
    pushAll(s, v, 32);
  };
}

export function pushaSemantic(): SemanticTemplate {
  return (s, v) => {
    pushAll(s, v, 16);
  };
}

export function popadSemantic(): SemanticTemplate {
  return (s, v) => {
    popAll(s, v, 32);
  };
}

export function popaSemantic(): SemanticTemplate {
  return (s, v) => {
    popAll(s, v, 16);
  };
}

function pushAll(s: SemanticsBuilder, v: ValueBuilder, width: StackOperandWidth): void {
  const esp = s.read(s.reg("esp"), { width: 32 });
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const nextEsp = v.binary("sub", esp, v.const(totalBytes));
  const access = s.memory.access({
    reference: s.memory.reference("ss", nextEsp),
    byteLength: v.const(totalBytes),
    intent: "write"
  });

  const values = width === 32
    ? pushadRegisters.map((reg) => reg === "esp" ? esp : s.read(s.reg(reg), { width: 32 }))
    : pushaRegisters.map((reg) => reg === "sp" ? v.truncate(16, esp) : s.read(s.reg(reg), { width: 16 }));

  values.forEach((value, index) => {
    const byteOffset = totalBytes - cellBytes * (index + 1);

    s.memory.write(access, { width, byteOffset: v.const(byteOffset), value });
  });
  s.write(s.reg("esp"), nextEsp, { width: 32 });
}

function popAll(s: SemanticsBuilder, v: ValueBuilder, width: StackOperandWidth): void {
  const esp = s.read(s.reg("esp"), { width: 32 });
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const cells = width === 32 ? popadCells : popaCells;
  const access = s.memory.access({
    reference: s.memory.reference("ss", esp),
    byteLength: v.const(totalBytes),
    intent: "read"
  });

  const loaded = cells.map(([reg, offset]) => ({
    reg,
    value: s.memory.read(access, { width, byteOffset: v.const(offset) })
  }));
  const nextEsp = v.binary("add", esp, v.const(totalBytes));

  for (const { reg, value } of loaded) {
    s.write(s.reg(reg), value, { width });
  }

  s.write(s.reg("esp"), nextEsp, { width: 32 });
}

function pushFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  // Reserved bit 1 and the user-mode IF image bit are set.
  pushStack(s, v, width, buildFlagImage(s, v, flags, 0x202));
}

function popFlags(
  s: SemanticsBuilder,
  v: ValueBuilder,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  const image = popStack(s, v, width);

  writeFlagsFromImage(s, v, flags, image);
}

export function popSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    // SDM order: esp is incremented before the destination EA is computed,
    // so an esp-based destination sees the new esp.
    const value = popStack(s, v, width);

    s.write(dst, value, { width });
  };
}

export function popSegmentSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const value = popStack(s, v, width);

    s.write(dst, value, { width: 16 });
  };
}

export function leaveSemantic(): SemanticTemplate {
  return (s, v) => {
    const frame = s.read(s.reg("ebp"), { width: 32 });
    const access = s.memory.access({
      reference: s.memory.reference("ss", frame),
      byteLength: v.const(4),
      intent: "read"
    });

    const savedFrame = s.memory.read(access, { width: 32 });
    const nextEsp = v.binary("add", frame, v.const(4));

    s.write(s.reg("esp"), nextEsp, { width: 32 });
    s.write(s.reg("ebp"), savedFrame, { width: 32 });
  };
}

function stackByteLength(width: StackOperandWidth): 2 | 4 {
  return width === 16 ? 2 : 4;
}
