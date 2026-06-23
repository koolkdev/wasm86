import { strictEqual } from "node:assert";

import type { StateChannel } from "#ir/slots.js";
import { x86StatusFlags, type X86Flag, type X86StatusFlag } from "#x86/flags.js";
import { u32 } from "#x86/numeric.js";
import type { WasmCpuState, WasmCpuStateInit, WasmCpuStateSnapshot } from "#wasm/host/cpu-state.js";
import {
  wasmCpuStateChannelAccessByteLength,
  wasmCpuStateChannelOffset,
  WASM_CPU_STATE_BYTE_LENGTH,
  WASM_CPU_STATE_FIELDS,
  WASM_CPU_STATE_LAYOUT,
  wasmCpuFlagByteOffset,
  type WasmCpuStateField
} from "#wasm/cpu-state-layout.js";

export type { WasmCpuStateInit, WasmCpuStateSnapshot } from "#wasm/host/cpu-state.js";
export type { WasmCpuStateField } from "#wasm/cpu-state-layout.js";
export type WasmCpuStatusFlag = X86StatusFlag;

export const wasmCpuStateSnapshotFields = WASM_CPU_STATE_FIELDS;

export function createWasmCpuStateSnapshot(overrides: WasmCpuStateInit = {}): WasmCpuStateSnapshot {
  const view = new DataView(new ArrayBuffer(WASM_CPU_STATE_BYTE_LENGTH));

  writeWasmCpuStateSnapshot(view, overrides);

  return readWasmCpuStateSnapshot(view);
}

export function readWasmCpuStateSnapshot(view: DataView): WasmCpuStateSnapshot {
  const state = {} as WasmCpuStateSnapshot;

  for (const field of wasmCpuStateSnapshotFields) {
    state[field] = readWasmCpuStateField(view, field);
  }

  return state;
}

export function readWasmCpuState(state: WasmCpuState): WasmCpuStateSnapshot {
  return readWasmCpuStateSnapshot(new DataView(state.memory.buffer));
}

export function writeWasmCpuStateSnapshot(view: DataView, state: WasmCpuStateInit): void {
  for (const field of wasmCpuStateSnapshotFields) {
    writeWasmCpuStateField(view, field, state[field] ?? 0);
  }
}

export function readWasmCpuStateField(view: DataView, field: WasmCpuStateField): number {
  const layout = WASM_CPU_STATE_LAYOUT[field];

  switch (layout.byteLength) {
    case 1:
      return view.getUint8(layout.offset);
    case 4:
      return view.getUint32(layout.offset, true);
  }
}

export function writeWasmCpuStateField(view: DataView, field: WasmCpuStateField, value: number): void {
  const layout = WASM_CPU_STATE_LAYOUT[field];

  switch (layout.byteLength) {
    case 1:
      view.setUint8(layout.offset, value === 0 ? 0 : 1);
      break;
    case 4:
      view.setUint32(layout.offset, u32(value), true);
      break;
  }
}

export function readWasmCpuStateChannel(view: DataView, channel: StateChannel): number {
  const offset = wasmCpuStateChannelOffset(channel);

  switch (wasmCpuStateChannelAccessByteLength(channel)) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, true);
    case 4:
      return view.getUint32(offset, true);
  }
}

export function writeWasmCpuStateChannel(view: DataView, channel: StateChannel, value: number): void {
  if (channel.kind === "flag") {
    writeWasmCpuFlagByte(view, channel.flag, value);
    return;
  }

  const offset = wasmCpuStateChannelOffset(channel);

  switch (wasmCpuStateChannelAccessByteLength(channel)) {
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

export function readWasmCpuFlagByte(view: DataView, flag: X86Flag): number {
  return view.getUint8(wasmCpuFlagByteOffset(flag));
}

export function writeWasmCpuFlagByte(view: DataView, flag: X86Flag, value: number): void {
  view.setUint8(wasmCpuFlagByteOffset(flag), value === 0 ? 0 : 1);
}

export function wasmCpuStatusFlagsOf(
  state: Pick<WasmCpuStateSnapshot, X86StatusFlag>
): Readonly<Record<X86StatusFlag, number>> {
  const flags = {} as Record<X86StatusFlag, number>;

  for (const flag of x86StatusFlags) {
    flags[flag] = state[flag];
  }

  return flags;
}

export function wasmCpuStateSnapshotsEqual(left: WasmCpuStateSnapshot, right: WasmCpuStateSnapshot): boolean {
  return wasmCpuStateSnapshotFields.every((field) => u32(left[field]) === u32(right[field]));
}

export function assertWasmCpuStateFields(
  actual: WasmCpuStateSnapshot,
  expected: Partial<WasmCpuStateSnapshot>,
  messagePrefix: string
): void {
  for (const [field, expectedValue] of Object.entries(expected)) {
    strictEqual(
      actual[field as WasmCpuStateField],
      expectedValue,
      `${messagePrefix}: expected state.${field}`
    );
  }
}
