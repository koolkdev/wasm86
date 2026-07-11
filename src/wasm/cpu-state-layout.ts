import { assert } from "#common/assert.js";
import type { SegmentChannelField, StateChannel } from "#ir/slots.js";
import { x86Flags, type X86Flag } from "#x86/flags.js";
import { LAZY_FLAGS_KIND } from "#ir/lazy-flags.js";
import { reg32, segmentRegisters, type SegmentRegister } from "#x86/types.js";

type WasmCpuStateLayoutEntry = Readonly<{
  offset: number;
  byteLength: 1 | 2 | 4;
}>;

export const WASM_CPU_STATE_LAYOUT = {
  eax: { offset: 0, byteLength: 4 },
  ecx: { offset: 4, byteLength: 4 },
  edx: { offset: 8, byteLength: 4 },
  ebx: { offset: 12, byteLength: 4 },
  esp: { offset: 16, byteLength: 4 },
  ebp: { offset: 20, byteLength: 4 },
  esi: { offset: 24, byteLength: 4 },
  edi: { offset: 28, byteLength: 4 },
  eip: { offset: 32, byteLength: 4 },
  instructionCount: { offset: 36, byteLength: 4 },
  lazyFlagsKind: { offset: 40, byteLength: 1 },
  lazyFlagsA: { offset: 44, byteLength: 4 },
  lazyFlagsB: { offset: 48, byteLength: 4 },
  CF: { offset: 52, byteLength: 1 },
  PF: { offset: 53, byteLength: 1 },
  AF: { offset: 54, byteLength: 1 },
  ZF: { offset: 55, byteLength: 1 },
  SF: { offset: 56, byteLength: 1 },
  OF: { offset: 57, byteLength: 1 },
  DF: { offset: 58, byteLength: 1 },
  TF: { offset: 59, byteLength: 1 },
  NT: { offset: 60, byteLength: 1 },
  AC: { offset: 61, byteLength: 1 },
  ID: { offset: 62, byteLength: 1 },
  esSelector: { offset: 64, byteLength: 2 },
  csSelector: { offset: 66, byteLength: 2 },
  ssSelector: { offset: 68, byteLength: 2 },
  dsSelector: { offset: 70, byteLength: 2 },
  fsSelector: { offset: 72, byteLength: 2 },
  gsSelector: { offset: 74, byteLength: 2 },
  esBase: { offset: 76, byteLength: 4 },
  csBase: { offset: 80, byteLength: 4 },
  ssBase: { offset: 84, byteLength: 4 },
  dsBase: { offset: 88, byteLength: 4 },
  fsBase: { offset: 92, byteLength: 4 },
  gsBase: { offset: 96, byteLength: 4 },
  esLimit: { offset: 100, byteLength: 4 },
  csLimit: { offset: 104, byteLength: 4 },
  ssLimit: { offset: 108, byteLength: 4 },
  dsLimit: { offset: 112, byteLength: 4 },
  fsLimit: { offset: 116, byteLength: 4 },
  gsLimit: { offset: 120, byteLength: 4 },
  esAccess: { offset: 124, byteLength: 4 },
  csAccess: { offset: 128, byteLength: 4 },
  ssAccess: { offset: 132, byteLength: 4 },
  dsAccess: { offset: 136, byteLength: 4 },
  fsAccess: { offset: 140, byteLength: 4 },
  gsAccess: { offset: 144, byteLength: 4 }
} as const satisfies Readonly<Record<string, WasmCpuStateLayoutEntry>>;

export type WasmCpuStateField = keyof typeof WASM_CPU_STATE_LAYOUT;

export const WASM_CPU_LAZY_FLAGS_KIND = LAZY_FLAGS_KIND;
export const WASM_CPU_SEGMENT_FIELDS = {
  es: { selector: "esSelector", base: "esBase", limit: "esLimit", access: "esAccess" },
  cs: { selector: "csSelector", base: "csBase", limit: "csLimit", access: "csAccess" },
  ss: { selector: "ssSelector", base: "ssBase", limit: "ssLimit", access: "ssAccess" },
  ds: { selector: "dsSelector", base: "dsBase", limit: "dsLimit", access: "dsAccess" },
  fs: { selector: "fsSelector", base: "fsBase", limit: "fsLimit", access: "fsAccess" },
  gs: { selector: "gsSelector", base: "gsBase", limit: "gsLimit", access: "gsAccess" }
} as const satisfies Readonly<Record<SegmentRegister, Readonly<Record<SegmentChannelField, WasmCpuStateField>>>>;

export const WASM_CPU_STATE_FIELDS = Object.keys(WASM_CPU_STATE_LAYOUT) as readonly WasmCpuStateField[];
export const WASM_CPU_STATE_OFFSETS = Object.fromEntries(
  WASM_CPU_STATE_FIELDS.map((field) => [field, WASM_CPU_STATE_LAYOUT[field].offset])
) as Readonly<Record<WasmCpuStateField, number>>;
export const WASM_CPU_FLAG_BYTE_OFFSETS = Object.fromEntries(
  x86Flags.map((flag) => {
    assert(WASM_CPU_STATE_LAYOUT[flag].byteLength === 1, `flag field ${flag} must be byte-sized`);
    return [flag, WASM_CPU_STATE_LAYOUT[flag].offset];
  })
) as Readonly<Record<X86Flag, number>>;

export const WASM_CPU_STATE_BYTE_LENGTH = Math.max(
  ...WASM_CPU_STATE_FIELDS.map((field) => WASM_CPU_STATE_LAYOUT[field].offset + WASM_CPU_STATE_LAYOUT[field].byteLength)
);

// Dynamic register access indexes the GPR words as one contiguous array in
// modrm register order.
export const WASM_CPU_GPR_BASE_OFFSET = WASM_CPU_STATE_OFFSETS.eax;
export const WASM_CPU_SEGMENT_SELECTOR_OFFSET = WASM_CPU_STATE_OFFSETS.esSelector;
export const WASM_CPU_SEGMENT_BASE_OFFSET = WASM_CPU_STATE_OFFSETS.esBase;
export const WASM_CPU_SEGMENT_LIMIT_OFFSET = WASM_CPU_STATE_OFFSETS.esLimit;
export const WASM_CPU_SEGMENT_ACCESS_OFFSET = WASM_CPU_STATE_OFFSETS.esAccess;

for (const [index, reg] of reg32.entries()) {
  assert(
    WASM_CPU_STATE_OFFSETS[reg] === WASM_CPU_GPR_BASE_OFFSET + index * 4,
    "cpu state layout GPR words must be contiguous in modrm register order"
  );
}

for (const [index, reg] of segmentRegisters.entries()) {
  assert(
    WASM_CPU_STATE_OFFSETS[WASM_CPU_SEGMENT_FIELDS[reg].selector] === WASM_CPU_SEGMENT_SELECTOR_OFFSET + index * 2,
    "cpu state layout segment selectors must be contiguous in segment register order"
  );
  assert(
    WASM_CPU_STATE_OFFSETS[WASM_CPU_SEGMENT_FIELDS[reg].base] === WASM_CPU_SEGMENT_BASE_OFFSET + index * 4,
    "cpu state layout segment bases must be contiguous in segment register order"
  );
  assert(
    WASM_CPU_STATE_OFFSETS[WASM_CPU_SEGMENT_FIELDS[reg].limit] === WASM_CPU_SEGMENT_LIMIT_OFFSET + index * 4,
    "cpu state layout segment limits must be contiguous in segment register order"
  );
  assert(
    WASM_CPU_STATE_OFFSETS[WASM_CPU_SEGMENT_FIELDS[reg].access] === WASM_CPU_SEGMENT_ACCESS_OFFSET + index * 4,
    "cpu state layout segment access words must be contiguous in segment register order"
  );
}

export function wasmCpuFlagByteOffset(flag: X86Flag): number {
  return WASM_CPU_FLAG_BYTE_OFFSETS[flag];
}

export function wasmCpuSegmentField(reg: SegmentRegister, field: SegmentChannelField): WasmCpuStateField {
  return WASM_CPU_SEGMENT_FIELDS[reg][field];
}

export function wasmCpuStateFieldIsBitField(field: WasmCpuStateField): field is X86Flag {
  return (x86Flags as readonly string[]).includes(field);
}

export function wasmCpuStateChannelOffset(channel: StateChannel): number {
  switch (channel.kind) {
    case "gpr":
      return WASM_CPU_STATE_OFFSETS[channel.reg] + channel.byteOffsetInReg;
    case "flag":
      return wasmCpuFlagByteOffset(channel.flag);
    case "segment":
      return WASM_CPU_STATE_OFFSETS[wasmCpuSegmentField(channel.reg, channel.field)];
    case "eip":
      return WASM_CPU_STATE_OFFSETS.eip;
    case "instructionCount":
      return WASM_CPU_STATE_OFFSETS.instructionCount;
    case "lazyFlags":
      return WASM_CPU_STATE_OFFSETS[channel.field];
  }
}

export function wasmCpuStateChannelAccessByteLength(channel: StateChannel): 1 | 2 | 4 {
  switch (channel.kind) {
    case "gpr":
      return channel.byteLength;
    case "flag":
      return 1;
    case "segment":
      return WASM_CPU_STATE_LAYOUT[wasmCpuSegmentField(channel.reg, channel.field)].byteLength;
    case "lazyFlags":
      return WASM_CPU_STATE_LAYOUT[channel.field].byteLength;
    case "eip":
    case "instructionCount":
      return 4;
  }
}
