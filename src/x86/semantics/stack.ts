import type { Values } from "#ir/values.js";
import type { SemanticBuildContext, SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandRef, Value, ValueInput } from "#x86/semantics/refs.js";
import { x86EflagsBitOffset, x86Flags, type X86Flag } from "#core/flags.js";
import type { OperandWidth, Reg16, Reg32 } from "#core/types.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";
import {
  readStorage,
  resolveMemoryAccess,
  resolveStorageRead,
  resolveStorageWrite,
  writeStorage,
  type ResolvedStorageAccess
} from "./memory.js";

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
  v: Values,
  width: StackOperandWidth,
  value: ValueInput
): void {
  const esp = s.get(s.reg("esp"));
  const nextEsp = v.binary("sub", esp, v.const(stackByteLength(width)));
  const stack = resolveMemoryAccess(
    s,
    s.mem("ss", nextEsp),
    v.const(stackByteLength(width)),
    "write"
  );

  s.memoryWrite(stack, v.const(0), value, width);
  s.set(s.reg("esp"), nextEsp);
}

export function popStack(
  s: SemanticsBuilder,
  v: Values,
  width: StackOperandWidth
): Value {
  const esp = s.get(s.reg("esp"));
  const stack = resolveMemoryAccess(
    s,
    s.mem("ss", esp),
    v.const(stackByteLength(width)),
    "read"
  );

  const value = s.memoryRead(stack, v.const(0), width);
  const nextEsp = v.binary("add", esp, v.const(stackByteLength(width)));

  s.set(s.reg("esp"), nextEsp);
  return value;
}

export function pushSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const src = s.operand(0);

    const source = resolveStorageRead(s, v, context, src, width);

    pushStack(s, v, width, readStorage(s, v, source, width));
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

function pushAll(s: SemanticsBuilder, v: Values, width: StackOperandWidth): void {
  const esp = s.get(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const nextEsp = v.binary("sub", esp, v.const(totalBytes));
  const access = resolveMemoryAccess(
    s,
    s.mem("ss", nextEsp),
    v.const(totalBytes),
    "write"
  );

  const values = width === 32
    ? pushadRegisters.map((reg) => reg === "esp" ? esp : s.get(s.reg(reg)))
    : pushaRegisters.map((reg) => reg === "sp" ? v.truncate(16, esp) : s.get(s.reg(reg), 16));

  values.forEach((value, index) => {
    const byteOffset = totalBytes - cellBytes * (index + 1);

    s.memoryWrite(access, v.const(byteOffset), value, width);
  });
  s.set(s.reg("esp"), nextEsp);
}

function popAll(s: SemanticsBuilder, v: Values, width: StackOperandWidth): void {
  const esp = s.get(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const cells = width === 32 ? popadCells : popaCells;
  const access = resolveMemoryAccess(
    s,
    s.mem("ss", esp),
    v.const(totalBytes),
    "read"
  );
  const loaded = cells.map(([reg, offset]) => ({
    reg,
    value: s.memoryRead(access, v.const(offset), width)
  }));
  const nextEsp = v.binary("add", esp, v.const(totalBytes));

  for (const { reg, value } of loaded) {
    s.set(s.reg(reg), value, width);
  }

  s.set(s.reg("esp"), nextEsp);
}

function pushFlags(
  s: SemanticsBuilder,
  v: Values,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  // Reserved bit 1 and the user-mode IF image bit are set.
  pushStack(s, v, width, buildFlagImage(s, v, flags, 0x202));
}

function popFlags(
  s: SemanticsBuilder,
  v: Values,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  const image = popStack(s, v, width);

  writeFlagsFromImage(s, v, flags, image);
}

export function popSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    // SDM order: esp is incremented before the destination EA is computed,
    // so an esp-based destination sees the new esp.
    const value = popStack(s, v, width);

    writeStorage(s, v, popTargetStorage(s, v, context, width, dst), value, width);
  };
}

export function popSegmentSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v) => {
    const dst = s.operand(0);
    const value = popStack(s, v, width);

    s.set(dst, value, 16);
  };
}

export function leaveSemantic(): SemanticTemplate {
  return (s, v) => {
    const frame = s.get(s.reg("ebp"));
    const access = resolveMemoryAccess(s, s.mem("ss", frame), v.const(4), "read");
    const savedFrame = s.memoryRead(access, v.const(0), 32);
    const nextEsp = v.binary("add", frame, v.const(4));

    s.set(s.reg("esp"), nextEsp);
    s.set(s.reg("ebp"), savedFrame);
  };
}

function popTargetStorage(
  s: SemanticsBuilder,
  v: Values,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  dst: OperandRef
): ResolvedStorageAccess<"write"> {
  if (context.operandInfo(dst).storage === "mem") {
    return {
      kind: "memory",
      access: resolveMemoryAccess(s, s.operandMem(dst), v.const(stackByteLength(width)), "write")
    };
  }

  return resolveStorageWrite(s, v, context, dst, width);
}

function stackByteLength(width: StackOperandWidth): 2 | 4 {
  return width === 16 ? 2 : 4;
}
