import type { Values } from "#ir/values.js";
import type { SemanticBuildContext, SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandRef, StorageInput, Value, ValueInput } from "#x86/semantics/refs.js";
import { x86EflagsBitOffset, x86Flags, type X86Flag } from "#x86/flags.js";
import type { OperandWidth, Reg16, Reg32, RegName } from "#x86/types.js";
import { buildFlagImage, writeFlagsFromImage } from "./flag-image.js";
import { guardStorageRead, guardStorageWrite } from "./memory.js";

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
  context: SemanticBuildContext,
  width: StackOperandWidth,
  value: ValueInput
): void {
  const esp = s.get(s.reg("esp"));
  const nextEsp = v.binary("sub", esp, v.const(stackByteLength(width)));
  const stack = s.mem(nextEsp);

  guardStorageWrite(s, context, stack, width);
  s.set(stack, value, width);
  s.set(s.reg("esp"), nextEsp);
}

export function popStack(
  s: SemanticsBuilder,
  v: Values,
  context: SemanticBuildContext,
  width: StackOperandWidth
): Value {
  const esp = s.get(s.reg("esp"));
  const stack = s.mem(esp);

  guardStorageRead(s, context, stack, width);
  const value = s.get(stack, width);
  const nextEsp = v.binary("add", esp, v.const(stackByteLength(width)));

  s.set(s.reg("esp"), nextEsp);
  return value;
}

export function pushSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const src = s.operand(0);

    guardStorageRead(s, context, src, width);
    pushStack(s, v, context, width, s.get(src, width));
  };
}

export function pushfdSemantic(): SemanticTemplate {
  return (s, v, context) => {
    pushFlags(s, v, context, 32, x86Flags);
  };
}

export function pushfSemantic(): SemanticTemplate {
  return (s, v, context) => {
    pushFlags(s, v, context, 16, x86Low16Flags);
  };
}

export function popfdSemantic(): SemanticTemplate {
  return (s, v, context) => {
    popFlags(s, v, context, 32, x86Flags);
  };
}

export function popfSemantic(): SemanticTemplate {
  return (s, v, context) => {
    popFlags(s, v, context, 16, x86Low16Flags);
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

  s.memoryGuard(nextEsp, totalBytes, "write");

  const values = width === 32
    ? pushadRegisters.map((reg) => reg === "esp" ? esp : s.get(s.reg(reg)))
    : pushaRegisters.map((reg) => reg === "sp" ? v.truncate(16, esp) : s.get(s.reg(reg), 16));

  values.forEach((value, index) => {
    const address = v.binary("sub", esp, v.const(cellBytes * (index + 1)));

    s.set(s.mem(address), value, width);
  });
  s.set(s.reg("esp"), nextEsp);
}

function popAll(s: SemanticsBuilder, v: Values, width: StackOperandWidth): void {
  const esp = s.get(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;

  s.memoryGuard(esp, totalBytes, "read");

  const loaded = width === 32
    ? popCells(s, v, esp, 32, popadCells)
    : popCells(s, v, esp, 16, popaCells);
  const nextEsp = v.binary("add", esp, v.const(totalBytes));

  for (const { reg, value } of loaded) {
    s.set(s.reg(reg), value, width);
  }

  s.set(s.reg("esp"), nextEsp);
}

function popCells<TReg extends RegName>(
  s: SemanticsBuilder,
  v: Values,
  esp: ValueInput,
  width: StackOperandWidth,
  cells: readonly (readonly [TReg, number])[]
): ReadonlyArray<Readonly<{ reg: TReg; value: Value }>> {
  return cells.map(([reg, offset]) => ({
    reg,
    value: s.get(s.mem(offset === 0 ? esp : v.binary("add", esp, v.const(offset))), width)
  }));
}

function pushFlags(
  s: SemanticsBuilder,
  v: Values,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  // Reserved bit 1 and the user-mode IF image bit are set.
  pushStack(s, v, context, width, buildFlagImage(s, v, flags, 0x202));
}

function popFlags(
  s: SemanticsBuilder,
  v: Values,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  const image = popStack(s, v, context, width);

  writeFlagsFromImage(s, v, flags, image);
}

export function popSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    // SDM order: esp is incremented before the destination EA is computed,
    // so an esp-based destination sees the new esp.
    const value = popStack(s, v, context, width);

    s.set(popTargetStorage(s, context, width, dst), value, width);
  };
}

export function popSegmentSemantic(width: StackOperandWidth = 32): SemanticTemplate {
  return (s, v, context) => {
    const dst = s.operand(0);
    const value = popStack(s, v, context, width);

    s.set(dst, value, 16);
  };
}

export function leaveSemantic(): SemanticTemplate {
  return (s, v, context) => {
    const frame = s.get(s.reg("ebp"));
    const savedFrameStorage = s.mem(frame);

    guardStorageRead(s, context, savedFrameStorage, 32);
    const savedFrame = s.get(savedFrameStorage);
    const nextEsp = v.binary("add", frame, v.const(4));

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
    const target = s.mem(s.linearAddress(dst));

    guardStorageWrite(s, context, target, width);
    return target;
  }

  guardStorageWrite(s, context, dst, width);
  return dst;
}

function stackByteLength(width: StackOperandWidth): 2 | 4 {
  return width === 16 ? 2 : 4;
}
