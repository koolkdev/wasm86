import { assert } from "#common/assert.js";
import type { StateChannel } from "#ir/action/slots.js";
import { x86Flags, type X86Flag } from "#x86/flags.js";
import { reg32, type Reg32 } from "#x86/types.js";
import { u32 } from "#x86/numeric.js";
import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";

export type WasmStateField = Reg32 | "eip" | "instructionCount" | "stopReason";

export const WASM_STATE_OFFSETS = {
  eax: 0,
  ecx: 4,
  edx: 8,
  ebx: 12,
  esp: 16,
  ebp: 20,
  esi: 24,
  edi: 28,
  eip: 32,
  instructionCount: 36,
  stopReason: 40
} as const satisfies Readonly<Record<WasmStateField, number>>;

// Dynamic register access indexes the GPR words as one contiguous array in
// modrm register order.
export const WASM_GPR_BASE_OFFSET = WASM_STATE_OFFSETS.eax;

for (const [index, reg] of reg32.entries()) {
  assert(
    WASM_STATE_OFFSETS[reg] === WASM_GPR_BASE_OFFSET + index * 4,
    "state layout GPR words must be contiguous in modrm register order"
  );
}

export const WASM_FLAG_BYTE_OFFSETS = {
  CF: 44,
  PF: 45,
  AF: 46,
  ZF: 47,
  SF: 48,
  OF: 49
} as const satisfies Readonly<Record<X86Flag, number>>;

export const WASM_STATE_BYTE_LENGTH = 50;
export const WASM_STATE_FIELDS = [
  ...reg32,
  "eip",
  "instructionCount",
  "stopReason"
] as const satisfies readonly WasmStateField[];

export function flagStateOffset(flag: X86Flag): number {
  return WASM_FLAG_BYTE_OFFSETS[flag];
}

export function channelStateOffset(channel: StateChannel): number {
  switch (channel.kind) {
    case "gpr":
      return WASM_STATE_OFFSETS[channel.reg] + channel.byteOffsetInReg;
    case "flag":
      return flagStateOffset(channel.flag);
    case "eip":
      return WASM_STATE_OFFSETS.eip;
    case "instructionCount":
      return WASM_STATE_OFFSETS.instructionCount;
  }
}

export function readWasmStateChannel(view: DataView, channel: StateChannel): number {
  const offset = channelStateOffset(channel);

  switch (channelAccessByteLength(channel)) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, true);
    case 4:
      return view.getUint32(offset, true);
  }
}

export function writeWasmStateChannel(view: DataView, channel: StateChannel, value: number): void {
  if (channel.kind === "flag") {
    writeWasmFlagByte(view, channel.flag, value);
    return;
  }

  const offset = channelStateOffset(channel);

  switch (channelAccessByteLength(channel)) {
    case 1:
      view.setUint8(offset, value);
      break;
    case 2:
      view.setUint16(offset, value, true);
      break;
    case 4:
      view.setUint32(offset, u32(value), true);
      break;
  }
}

export function channelAccessByteLength(channel: StateChannel): 1 | 2 | 4 {
  switch (channel.kind) {
    case "gpr":
      return channel.byteLength;
    case "flag":
      return 1;
    case "eip":
    case "instructionCount":
      return 4;
  }
}

export function readWasmFlagByte(view: DataView, flag: X86Flag): number {
  return view.getUint8(WASM_FLAG_BYTE_OFFSETS[flag]);
}

export function writeWasmFlagByte(view: DataView, flag: X86Flag, value: number): void {
  view.setUint8(WASM_FLAG_BYTE_OFFSETS[flag], value === 0 ? 0 : 1);
}

export function readWasmStateField(view: DataView, field: WasmStateField): number {
  return view.getUint32(WASM_STATE_OFFSETS[field], true);
}

export function writeWasmStateField(view: DataView, field: WasmStateField, value: number): void {
  view.setUint32(WASM_STATE_OFFSETS[field], u32(value), true);
}

export function readWasmCpuState(view: DataView): CpuState {
  const state = createCpuState();

  for (const reg of reg32) {
    state[reg] = readWasmStateField(view, reg);
  }

  state.eip = readWasmStateField(view, "eip");

  for (const flag of x86Flags) {
    state[flag] = readWasmFlagByte(view, flag);
  }

  state.instructionCount = readWasmStateField(view, "instructionCount");
  state.stopReason = readWasmStateField(view, "stopReason");

  return state;
}

export function writeWasmCpuState(view: DataView, stateInit: Partial<CpuState>): void {
  const state = createCpuState(stateInit);

  for (const reg of reg32) {
    writeWasmStateField(view, reg, state[reg]);
  }

  writeWasmStateField(view, "eip", state.eip);

  for (const flag of x86Flags) {
    writeWasmFlagByte(view, flag, state[flag]);
  }

  writeWasmStateField(view, "instructionCount", state.instructionCount);
  writeWasmStateField(view, "stopReason", state.stopReason);
}
