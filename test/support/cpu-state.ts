import { strictEqual } from "node:assert";

import { assert } from "#common/assert.js";
import { LAZY_FLAGS_KIND } from "#core/flags/state.js";
import { x86StatusFlags, x86Flags, type X86Flag, type X86StatusFlag } from "#core/flags/definitions.js";
import { u32 } from "#core/numeric.js";
import { reg32, segmentRegisters } from "#core/types.js";
import { lazyFlagsKindByte } from "#ir/lazy-flags.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  instructionCountChannel,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  segmentAccessChannel,
  segmentBaseChannel,
  segmentLimitChannel,
  segmentSelectorChannel,
  type StateChannel
} from "#ir/slots.js";
import { executionStateLayout, stateSlotLocation, type StateLocation } from "#ir/state-layout.js";
import {
  wasmCpuStateFields,
  type WasmCpuState,
  type WasmCpuStateField,
  type WasmCpuStateInit,
  type WasmCpuStateSnapshot
} from "#wasm/host/cpu-state.js";

export type { WasmCpuStateField, WasmCpuStateInit, WasmCpuStateSnapshot } from "#wasm/host/cpu-state.js";
export type WasmCpuStatusFlag = X86StatusFlag;
export type WasmCpuExpectedLazyFlagState = Readonly<{
  kind: keyof typeof LAZY_FLAGS_KIND;
  width: 0 | 8 | 16 | 32;
  a?: number;
  b?: number;
}>;

type WasmCpuLazyFlagStateSnapshot = Pick<
  WasmCpuStateSnapshot,
  "lazyFlagsKind" | "lazyFlagsA" | "lazyFlagsB"
>;

export const wasmCpuStateSnapshotFields = wasmCpuStateFields;

const wasmCpuStateFieldLocations = createWasmCpuStateFieldLocations();

export function createWasmCpuStateSnapshot(overrides: WasmCpuStateInit = {}): WasmCpuStateSnapshot {
  const view = new DataView(new ArrayBuffer(executionStateLayout.byteLength));

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
  const resolved = resolveLocation(wasmCpuStateFieldLocations[field]);

  return readUnsigned(view, resolved.offset, resolved.byteLength);
}

export function writeWasmCpuStateField(view: DataView, field: WasmCpuStateField, value: number): void {
  const resolved = resolveLocation(wasmCpuStateFieldLocations[field]);
  const normalized = (x86Flags as readonly string[]).includes(field)
    ? (value === 0 ? 0 : 1)
    : value;

  writeUnsigned(view, resolved.offset, resolved.byteLength, normalized);
}

export function assertLazyFlagState(
  state: DataView | WasmCpuLazyFlagStateSnapshot,
  expected: WasmCpuExpectedLazyFlagState,
  label = "lazy flags"
): void {
  const actual = state instanceof DataView
    ? {
        lazyFlagsKind: readWasmCpuStateField(state, "lazyFlagsKind"),
        lazyFlagsA: readWasmCpuStateField(state, "lazyFlagsA"),
        lazyFlagsB: readWasmCpuStateField(state, "lazyFlagsB")
      }
    : state;

  strictEqual(
    actual.lazyFlagsKind,
    lazyFlagsKindByte(LAZY_FLAGS_KIND[expected.kind], expected.width),
    `${label} lazy kind byte`
  );

  if (expected.a !== undefined) {
    strictEqual(actual.lazyFlagsA, expected.a >>> 0, `${label} lazy A`);
  }

  if (expected.b !== undefined) {
    strictEqual(actual.lazyFlagsB, expected.b >>> 0, `${label} lazy B`);
  }
}

export function readWasmCpuStateChannel(view: DataView, channel: StateChannel): number {
  const resolved = resolveLocation(stateSlotLocation(channel));

  return readUnsigned(view, resolved.offset, resolved.byteLength);
}

export function writeWasmCpuStateChannel(view: DataView, channel: StateChannel, value: number): void {
  if (channel.kind === "flag") {
    writeWasmCpuFlagByte(view, channel.flag, value);
    return;
  }

  const resolved = resolveLocation(stateSlotLocation(channel));

  writeUnsigned(view, resolved.offset, resolved.byteLength, value);
}

export function readWasmCpuFlagByte(view: DataView, flag: X86Flag): number {
  return readWasmCpuStateChannel(view, flagChannel(flag));
}

export function writeWasmCpuFlagByte(view: DataView, flag: X86Flag, value: number): void {
  const resolved = resolveLocation(stateSlotLocation(flagChannel(flag)));

  view.setUint8(resolved.offset, value === 0 ? 0 : 1);
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

function createWasmCpuStateFieldLocations(): Record<WasmCpuStateField, StateLocation> {
  const locations = {} as Record<WasmCpuStateField, StateLocation>;

  for (const reg of reg32) {
    locations[reg] = stateSlotLocation(gprChannel(reg));
  }
  locations.eip = stateSlotLocation(eipChannel);
  locations.instructionCount = stateSlotLocation(instructionCountChannel);
  locations.lazyFlagsKind = stateSlotLocation(lazyFlagsKindChannel);
  locations.lazyFlagsA = stateSlotLocation(lazyFlagsAChannel);
  locations.lazyFlagsB = stateSlotLocation(lazyFlagsBChannel);

  for (const flag of x86Flags) {
    locations[flag] = stateSlotLocation(flagChannel(flag));
  }
  for (const reg of segmentRegisters) {
    locations[`${reg}Selector`] = stateSlotLocation(segmentSelectorChannel(reg));
    locations[`${reg}Base`] = stateSlotLocation(segmentBaseChannel(reg));
    locations[`${reg}Limit`] = stateSlotLocation(segmentLimitChannel(reg));
    locations[`${reg}Access`] = stateSlotLocation(segmentAccessChannel(reg));
  }

  return locations;
}

function resolveLocation(location: StateLocation): Readonly<{
  offset: number;
  byteLength: 1 | 2 | 4;
}> {
  switch (location.kind) {
    case "field":
      return executionStateLayout.field(location.field);
    case "element": {
      const array = executionStateLayout.array(location.array);

      assert(location.index < array.count, `state element index ${location.index} is out of range`);
      return {
        offset: array.offset + location.index * array.stride + location.byteOffset,
        byteLength: location.byteLength
      };
    }
    case "array":
      assert(false, "a dynamic state array has no static test address");
  }
}

function readUnsigned(view: DataView, offset: number, byteLength: 1 | 2 | 4): number {
  switch (byteLength) {
    case 1:
      return view.getUint8(offset);
    case 2:
      return view.getUint16(offset, true);
    case 4:
      return view.getUint32(offset, true);
  }
}

function writeUnsigned(
  view: DataView,
  offset: number,
  byteLength: 1 | 2 | 4,
  value: number
): void {
  switch (byteLength) {
    case 1:
      view.setUint8(offset, u32(value) & 0xff);
      return;
    case 2:
      view.setUint16(offset, u32(value) & 0xffff, true);
      return;
    case 4:
      view.setUint32(offset, u32(value), true);
      return;
  }
}
