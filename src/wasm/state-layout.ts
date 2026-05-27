import {
  x86ArithmeticFlagsFromEflags,
  x86ArithmeticFlagsMask,
  x86ArithmeticFlagsToEflags,
  x86ControlFlagsFromEflags,
  x86MergeSplitEflags,
  x86NonArithmeticEflagsMask
} from "#x86/flags.js";
import { reg32, type Reg32 } from "#x86/types.js";
import { u32 } from "#x86/numeric.js";
import { createCpuState, type CpuState } from "#x86/state/cpu-state.js";

export type WasmStateField = Reg32 | "eip" | "aluFlags" | "ctrlFlags" | "instructionCount" | "stopReason";

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

export const WASM_STATE_BYTE_LENGTH = 52;
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

export function readWasmStateField(view: DataView, field: WasmStateField): number {
  return view.getUint32(WASM_STATE_OFFSETS[field], true);
}

export function writeWasmStateField(view: DataView, field: WasmStateField, value: number): void {
  view.setUint32(WASM_STATE_OFFSETS[field], normalizeWasmStateField(field, value), true);
}

export function readWasmCpuState(view: DataView): CpuState {
  const state = createCpuState();

  for (const reg of reg32) {
    state[reg] = readWasmStateField(view, reg);
  }

  state.eip = readWasmStateField(view, "eip");
  state.eflags = mergeWasmEflags(readWasmStateField(view, "aluFlags"), readWasmStateField(view, "ctrlFlags"));
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
