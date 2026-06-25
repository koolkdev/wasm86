import { assert } from "#common/assert.js";
import type { StateChannel } from "#ir/slots.js";
import { x86Flags, type X86Flag } from "#x86/flags.js";
import { reg32 } from "#x86/types.js";

type WasmCpuStateLayoutEntry = Readonly<{
  offset: number;
  byteLength: 1 | 4;
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
  CF: { offset: 41, byteLength: 1 },
  PF: { offset: 42, byteLength: 1 },
  AF: { offset: 43, byteLength: 1 },
  ZF: { offset: 44, byteLength: 1 },
  SF: { offset: 45, byteLength: 1 },
  OF: { offset: 46, byteLength: 1 },
  DF: { offset: 47, byteLength: 1 },
  TF: { offset: 48, byteLength: 1 },
  NT: { offset: 49, byteLength: 1 },
  AC: { offset: 50, byteLength: 1 },
  ID: { offset: 51, byteLength: 1 },
  lazyFlagsA: { offset: 52, byteLength: 4 },
  lazyFlagsB: { offset: 56, byteLength: 4 }
} as const satisfies Readonly<Record<string, WasmCpuStateLayoutEntry>>;

export type WasmCpuStateField = keyof typeof WASM_CPU_STATE_LAYOUT;

export const WASM_CPU_LAZY_FLAGS_KIND = {
  NONE: 0,
  SUB32: 1,
  LOGIC_RESULT32: 2
} as const;

export type WasmCpuLazyFlagsKind = (typeof WASM_CPU_LAZY_FLAGS_KIND)[keyof typeof WASM_CPU_LAZY_FLAGS_KIND];

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

for (const [index, reg] of reg32.entries()) {
  assert(
    WASM_CPU_STATE_OFFSETS[reg] === WASM_CPU_GPR_BASE_OFFSET + index * 4,
    "cpu state layout GPR words must be contiguous in modrm register order"
  );
}

export function wasmCpuFlagByteOffset(flag: X86Flag): number {
  return WASM_CPU_FLAG_BYTE_OFFSETS[flag];
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
    case "lazyFlags":
      return WASM_CPU_STATE_LAYOUT[channel.field].byteLength;
    case "eip":
    case "instructionCount":
      return 4;
  }
}
