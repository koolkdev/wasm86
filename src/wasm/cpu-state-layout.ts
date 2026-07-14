import { assert } from "#common/assert.js";
import { cpuExecutionStateFields } from "#cpu/execution-state.js";
import { x86Flags, type X86Flag } from "#core/flags/definitions.js";
import { flagStateFields, LAZY_FLAGS_KIND } from "#core/flags/state.js";
import { eipField, gprFields, segmentFields } from "#core/state/fields.js";
import type { SegmentRegister } from "#core/types.js";
import type { SegmentChannelField, StateChannel } from "#ir/slots.js";

type WasmCpuStateLayoutEntry = Readonly<{
  offset: number;
  byteLength: 1 | 2 | 4;
}>;

const [eax, ecx, edx, ebx, esp, ebp, esi, edi] = gprFields;
const [esSelector, csSelector, ssSelector, dsSelector, fsSelector, gsSelector] = segmentFields.selectors;
const [esBase, csBase, ssBase, dsBase, fsBase, gsBase] = segmentFields.bases;
const [esLimit, csLimit, ssLimit, dsLimit, fsLimit, gsLimit] = segmentFields.limits;
const [esAccess, csAccess, ssAccess, dsAccess, fsAccess, gsAccess] = segmentFields.access;

export const WASM_CPU_STATE_LAYOUT = {
  eax,
  ecx,
  edx,
  ebx,
  esp,
  ebp,
  esi,
  edi,
  eip: eipField,
  instructionCount: cpuExecutionStateFields.instructionCount,
  lazyFlagsKind: flagStateFields.lazyKind,
  lazyFlagsA: flagStateFields.lazyA,
  lazyFlagsB: flagStateFields.lazyB,
  CF: flagStateFields.concrete.CF,
  PF: flagStateFields.concrete.PF,
  AF: flagStateFields.concrete.AF,
  ZF: flagStateFields.concrete.ZF,
  SF: flagStateFields.concrete.SF,
  OF: flagStateFields.concrete.OF,
  DF: flagStateFields.concrete.DF,
  TF: flagStateFields.concrete.TF,
  NT: flagStateFields.concrete.NT,
  AC: flagStateFields.concrete.AC,
  ID: flagStateFields.concrete.ID,
  esSelector,
  csSelector,
  ssSelector,
  dsSelector,
  fsSelector,
  gsSelector,
  esBase,
  csBase,
  ssBase,
  dsBase,
  fsBase,
  gsBase,
  esLimit,
  csLimit,
  ssLimit,
  dsLimit,
  fsLimit,
  gsLimit,
  esAccess,
  csAccess,
  ssAccess,
  dsAccess,
  fsAccess,
  gsAccess
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
