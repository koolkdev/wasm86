import { assert } from "#common/assert.js";
import type { StateChannel } from "#ir/action/slots.js";
import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags,
  x86ArithmeticFlagsFromEflags,
  x86ArithmeticFlagsMask,
  x86ArithmeticFlagsToEflags,
  x86ControlFlagsFromEflags,
  x86MergeSplitEflags,
  x86NonArithmeticEflagsMask,
  type X86ArithmeticFlag
} from "#x86/flags.js";
import { reg32, type Reg32 } from "#x86/types.js";
import { u32 } from "#x86/numeric.js";
import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";

export type WasmStateField = Reg32 | "eip" | "aluFlags" | "ctrlFlags" | "instructionCount" | "stopReason";

export type WasmFlagsRepresentation = "packed" | "bytes";

export type WasmSplitEflags = Readonly<{
  aluFlags: number;
  ctrlFlags: number;
}>;

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
  aluFlags: 36,
  ctrlFlags: 40,
  instructionCount: 44,
  stopReason: 48
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
  CF: 52,
  PF: 53,
  AF: 54,
  ZF: 55,
  SF: 56,
  OF: 57
} as const satisfies Readonly<Record<X86ArithmeticFlag, number>>;

export const WASM_STATE_BYTE_LENGTH = 58;
export const WASM_STATE_FIELDS = [
  ...reg32,
  "eip",
  "aluFlags",
  "ctrlFlags",
  "instructionCount",
  "stopReason"
] as const satisfies readonly WasmStateField[];
export const WASM_ALU_FLAGS_MASK = x86ArithmeticFlagsMask;
export const WASM_CTRL_FLAGS_MASK = x86NonArithmeticEflagsMask;

export function splitEflagsForWasm(eflags: number): WasmSplitEflags {
  return {
    aluFlags: normalizeWasmAluFlags(x86ArithmeticFlagsFromEflags(eflags)),
    ctrlFlags: normalizeWasmCtrlFlags(x86ControlFlagsFromEflags(eflags))
  };
}

export function mergeWasmEflags(aluFlags: number, ctrlFlags: number): number {
  return x86MergeSplitEflags(aluFlags, ctrlFlags);
}

export function wasmAluFlagsToEflags(aluFlags: number): number {
  return x86ArithmeticFlagsToEflags(aluFlags);
}

export function normalizeWasmAluFlags(aluFlags: number): number {
  return u32(aluFlags & WASM_ALU_FLAGS_MASK);
}

export function normalizeWasmCtrlFlags(ctrlFlags: number): number {
  return u32(ctrlFlags & WASM_CTRL_FLAGS_MASK);
}

export function flagStateOffset(flag: X86ArithmeticFlag): number {
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
      return 4;
  }
}

export function readWasmFlagByte(view: DataView, flag: X86ArithmeticFlag): number {
  return view.getUint8(WASM_FLAG_BYTE_OFFSETS[flag]);
}

export function writeWasmFlagByte(view: DataView, flag: X86ArithmeticFlag, value: number): void {
  view.setUint8(WASM_FLAG_BYTE_OFFSETS[flag], value === 0 ? 0 : 1);
}

export function readWasmAluFlagBytes(view: DataView): number {
  let aluFlags = 0;

  for (const flag of x86ArithmeticFlags) {
    if (readWasmFlagByte(view, flag) !== 0) {
      aluFlags |= x86ArithmeticFlagMask[flag];
    }
  }

  return u32(aluFlags);
}

export function writeWasmAluFlagBytes(view: DataView, aluFlags: number): void {
  for (const flag of x86ArithmeticFlags) {
    writeWasmFlagByte(view, flag, aluFlags & x86ArithmeticFlagMask[flag]);
  }
}

export function readWasmStateField(view: DataView, field: WasmStateField): number {
  return view.getUint32(WASM_STATE_OFFSETS[field], true);
}

export function writeWasmStateField(view: DataView, field: WasmStateField, value: number): void {
  view.setUint32(WASM_STATE_OFFSETS[field], normalizeWasmStateField(field, value), true);
}

export function readWasmCpuState(view: DataView, flagsFrom: WasmFlagsRepresentation = "packed"): CpuState {
  const state = createCpuState();
  const aluFlags = flagsFrom === "bytes" ? readWasmAluFlagBytes(view) : readWasmStateField(view, "aluFlags");

  for (const reg of reg32) {
    state[reg] = readWasmStateField(view, reg);
  }

  state.eip = readWasmStateField(view, "eip");
  state.eflags = mergeWasmEflags(aluFlags, readWasmStateField(view, "ctrlFlags"));
  state.instructionCount = readWasmStateField(view, "instructionCount");
  state.stopReason = readWasmStateField(view, "stopReason");

  return state;
}

export function writeWasmCpuState(view: DataView, stateInit: Partial<CpuState>): void {
  const state = createCpuState(stateInit);
  const flags = splitEflagsForWasm(state.eflags);

  for (const reg of reg32) {
    writeWasmStateField(view, reg, state[reg]);
  }

  writeWasmStateField(view, "eip", state.eip);
  writeWasmStateField(view, "aluFlags", flags.aluFlags);
  writeWasmStateField(view, "ctrlFlags", flags.ctrlFlags);
  writeWasmAluFlagBytes(view, flags.aluFlags);
  writeWasmStateField(view, "instructionCount", state.instructionCount);
  writeWasmStateField(view, "stopReason", state.stopReason);
}

export function normalizeWasmStateField(field: WasmStateField, value: number): number {
  switch (field) {
    case "aluFlags":
      return normalizeWasmAluFlags(value);
    case "ctrlFlags":
      return normalizeWasmCtrlFlags(value);
    default:
      return u32(value);
  }
}
