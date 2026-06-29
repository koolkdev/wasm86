import type { SemanticBuildContext, SemanticsBuilder, SemanticTemplate } from "#x86/semantics/builder.js";
import type { OperandRef, StorageInput, Value, ValueInput } from "#x86/semantics/refs.js";
import { x86EflagsBitOffset, x86Flags, type X86Flag } from "#x86/flags.js";
import type { OperandWidth, Reg16, Reg32, RegName } from "#x86/types.js";
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
  context: SemanticBuildContext,
  width: StackOperandWidth,
  value: ValueInput
): void {
  const esp = s.get(s.reg("esp"));
  const nextEsp = s.binary("sub", esp, s.const32(stackByteLength(width)));
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
  const nextEsp = s.binary("add", esp, s.const32(stackByteLength(width)));

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
    pushFlags(s, context, 32, x86Flags);
  };
}

export function pushfSemantic(): SemanticTemplate {
  return (s, context) => {
    pushFlags(s, context, 16, x86Low16Flags);
  };
}

export function popfdSemantic(): SemanticTemplate {
  return (s, context) => {
    popFlags(s, context, 32, x86Flags);
  };
}

export function popfSemantic(): SemanticTemplate {
  return (s, context) => {
    popFlags(s, context, 16, x86Low16Flags);
  };
}

export function pushadSemantic(): SemanticTemplate {
  return (s) => {
    pushAll(s, 32);
  };
}

export function pushaSemantic(): SemanticTemplate {
  return (s) => {
    pushAll(s, 16);
  };
}

export function popadSemantic(): SemanticTemplate {
  return (s) => {
    popAll(s, 32);
  };
}

export function popaSemantic(): SemanticTemplate {
  return (s) => {
    popAll(s, 16);
  };
}

function pushAll(s: SemanticsBuilder, width: StackOperandWidth): void {
  const esp = s.get(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;
  const nextEsp = s.binary("sub", esp, s.const32(totalBytes));

  s.memoryGuard(nextEsp, totalBytes, "write");

  const values = width === 32
    ? pushadRegisters.map((reg) => reg === "esp" ? esp : s.get(s.reg(reg)))
    : pushaRegisters.map((reg) => reg === "sp" ? s.truncate(16, esp) : s.get(s.reg(reg), 16));

  values.forEach((value, index) => {
    const address = s.binary("sub", esp, s.const32(cellBytes * (index + 1)));

    s.set(s.mem(address), value, width);
  });
  s.set(s.reg("esp"), nextEsp);
}

function popAll(s: SemanticsBuilder, width: StackOperandWidth): void {
  const esp = s.get(s.reg("esp"));
  const cellBytes = stackByteLength(width);
  const totalBytes = cellBytes * 8;

  s.memoryGuard(esp, totalBytes, "read");

  const loaded = width === 32
    ? popCells(s, esp, 32, popadCells)
    : popCells(s, esp, 16, popaCells);
  const nextEsp = s.binary("add", esp, s.const32(totalBytes));

  for (const { reg, value } of loaded) {
    s.set(s.reg(reg), value, width);
  }

  s.set(s.reg("esp"), nextEsp);
}

function popCells<TReg extends RegName>(
  s: SemanticsBuilder,
  esp: ValueInput,
  width: StackOperandWidth,
  cells: readonly (readonly [TReg, number])[]
): ReadonlyArray<Readonly<{ reg: TReg; value: Value }>> {
  return cells.map(([reg, offset]) => ({
    reg,
    value: s.get(s.mem(offset === 0 ? esp : s.binary("add", esp, s.const32(offset))), width)
  }));
}

function pushFlags(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  // Reserved bit 1 and the user-mode IF image bit are set.
  let image: Value = s.const32(0x202);

  for (const flag of flags) {
    const bit = s.readFlag(flag);
    const offset = x86EflagsBitOffset[flag];

    image = s.binary("or", image, offset === 0 ? bit : s.binary("shl", bit, s.const32(offset)));
  }

  pushStack(s, context, width, image);
}

function popFlags(
  s: SemanticsBuilder,
  context: SemanticBuildContext,
  width: StackOperandWidth,
  flags: readonly X86Flag[]
): void {
  const image = popStack(s, context, width);
  const one = s.const32(1);

  for (const flag of flags) {
    const offset = x86EflagsBitOffset[flag];
    const shifted = offset === 0 ? image : s.binary("shr_u", image, s.const32(offset));

    s.writeFlag(flag, s.binary("and", shifted, one));
  }
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
    const nextEsp = s.binary("add", frame, s.const32(4));

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
