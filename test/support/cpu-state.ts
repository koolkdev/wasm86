import { strictEqual } from "node:assert";

import { assert } from "#common/assert.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import {
  flagStateFields,
  isConcreteFlagStateField
} from "#core/flags/layout.js";
import { x86StatusFlags, x86Flags, type X86Flag, type X86StatusFlag } from "#core/flags/definitions.js";
import type { SegmentStateField } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import { registerAlias } from "#core/registers.js";
import { u32 } from "#core/numeric.js";
import { reg32, segmentRegisters, type SegmentRegister } from "#core/types.js";
import { instructionCountField } from "#cpu/instruction-count.js";
import {
  type ArrayRef,
  type FieldRef,
  type LayoutByteLength,
  type LayoutWidth
} from "#compiler/layout/handles.js";
import type { InstructionStateChannel } from "#core/instruction/state/channels.js";
import {
  gprChannel,
  segmentAccessChannel,
  segmentBaseChannel,
  segmentLimitChannel,
  segmentSelectorChannel
} from "#core/state/channels.js";
import { testExecutionModel } from "#test/support/execution-model.js";

const cpuState = testExecutionModel.cpuState;

export const wasmCpuStateFields = [
  "eax",
  "ecx",
  "edx",
  "ebx",
  "esp",
  "ebp",
  "esi",
  "edi",
  "eip",
  "instructionCount",
  "lazyFlagsKind",
  "lazyFlagsA",
  "lazyFlagsB",
  "CF",
  "PF",
  "AF",
  "ZF",
  "SF",
  "OF",
  "DF",
  "TF",
  "NT",
  "AC",
  "ID",
  "esSelector",
  "csSelector",
  "ssSelector",
  "dsSelector",
  "fsSelector",
  "gsSelector",
  "esBase",
  "csBase",
  "ssBase",
  "dsBase",
  "fsBase",
  "gsBase",
  "esLimit",
  "csLimit",
  "ssLimit",
  "dsLimit",
  "fsLimit",
  "gsLimit",
  "esAccess",
  "csAccess",
  "ssAccess",
  "dsAccess",
  "fsAccess",
  "gsAccess"
] as const;

export type WasmCpuStateField = (typeof wasmCpuStateFields)[number];
export type WasmCpuStateSnapshot = Record<WasmCpuStateField, number>;
export type WasmCpuStateInit = Partial<WasmCpuStateSnapshot>;
type WasmCpuLazyFlagStateField =
  | "lazyFlagsKind"
  | "lazyFlagsA"
  | "lazyFlagsB";
export type WasmCpuArchitecturalStateSnapshot = Omit<
  WasmCpuStateSnapshot,
  WasmCpuLazyFlagStateField
>;
export type WasmCpuArchitecturalStateInit = Partial<
  WasmCpuArchitecturalStateSnapshot
>;
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

const gprByteLength = { 8: 1, 16: 2, 32: 4 } as const;
const wasmCpuStateFieldLocations = createWasmCpuStateFieldLocations();

export function createWasmCpuStateSnapshot(overrides: WasmCpuStateInit = {}): WasmCpuStateSnapshot {
  const view = new DataView(new ArrayBuffer(cpuState.layout.byteLength));

  writeWasmCpuStateSnapshot(view, overrides);

  return readWasmCpuStateSnapshot(view);
}

export function createWasmCpuArchitecturalStateSnapshot(
  overrides: WasmCpuArchitecturalStateInit = {}
): WasmCpuArchitecturalStateSnapshot {
  return wasmCpuArchitecturalStateOf(
    createWasmCpuStateSnapshot(overrides)
  );
}

export function readWasmCpuStateSnapshot(view: DataView): WasmCpuStateSnapshot {
  const state = {} as WasmCpuStateSnapshot;

  for (const field of wasmCpuStateSnapshotFields) {
    state[field] = readWasmCpuStateField(view, field);
  }

  return state;
}

export function wasmCpuArchitecturalStateOf(
  {
    lazyFlagsKind: _lazyFlagsKind,
    lazyFlagsA: _lazyFlagsA,
    lazyFlagsB: _lazyFlagsB,
    ...state
  }: WasmCpuStateSnapshot
): WasmCpuArchitecturalStateSnapshot {
  return state;
}

export function writeWasmCpuStateSnapshot(view: DataView, state: WasmCpuStateInit): void {
  for (const field of wasmCpuStateSnapshotFields) {
    writeWasmCpuStateField(view, field, state[field] ?? 0);
  }
}

export function readWasmCpuStateField(view: DataView, field: WasmCpuStateField): number {
  const resolved = wasmCpuStateFieldLocations[field];

  return readUnsigned(view, resolved.offset, resolved.byteLength);
}

export function writeWasmCpuStateField(view: DataView, field: WasmCpuStateField, value: number): void {
  const resolved = wasmCpuStateFieldLocations[field];
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

export function readWasmCpuStateChannel(view: DataView, channel: InstructionStateChannel): number {
  const resolved = channelLocation(channel);

  return readUnsigned(view, resolved.offset, resolved.byteLength);
}

export function writeWasmCpuStateChannel(view: DataView, channel: InstructionStateChannel, value: number): void {
  if (channel.kind === "field" && isConcreteFlagStateField(channel)) {
    const resolved = fieldLocation(channel);

    view.setUint8(resolved.offset, value === 0 ? 0 : 1);
    return;
  }

  const resolved = channelLocation(channel);

  writeUnsigned(view, resolved.offset, resolved.byteLength, value);
}

export function readWasmCpuFlagByte(view: DataView, flag: X86Flag): number {
  return readWasmCpuStateChannel(view, flagStateFields.concrete[flag]);
}

export function writeWasmCpuFlagByte(view: DataView, flag: X86Flag, value: number): void {
  const resolved = fieldLocation(flagStateFields.concrete[flag]);

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

type ResolvedLocation = Readonly<{
  offset: number;
  byteLength: LayoutByteLength;
}>;

function createWasmCpuStateFieldLocations(): Record<WasmCpuStateField, ResolvedLocation> {
  const locations = {} as Record<WasmCpuStateField, ResolvedLocation>;

  for (const reg of reg32) {
    locations[reg] = channelLocation(gprChannel(reg));
  }
  locations.eip = fieldLocation(coreStateFields.eip);
  locations.instructionCount = fieldLocation(instructionCountField);
  locations.lazyFlagsKind = fieldLocation(flagStateFields.lazyKind);
  locations.lazyFlagsA = fieldLocation(flagStateFields.lazyA);
  locations.lazyFlagsB = fieldLocation(flagStateFields.lazyB);

  for (const flag of x86Flags) {
    locations[flag] = fieldLocation(flagStateFields.concrete[flag]);
  }
  for (const reg of segmentRegisters) {
    locations[`${reg}Selector`] = channelLocation(segmentSelectorChannel(reg));
    locations[`${reg}Base`] = channelLocation(segmentBaseChannel(reg));
    locations[`${reg}Limit`] = channelLocation(segmentLimitChannel(reg));
    locations[`${reg}Access`] = channelLocation(segmentAccessChannel(reg));
  }

  return locations;
}

function channelLocation(channel: InstructionStateChannel): ResolvedLocation {
  switch (channel.kind) {
    case "field":
      return fieldLocation(channel);
    case "gpr": {
      const alias = registerAlias(channel.reg);
      return arrayElementLocation(
        coreStateFields.gprs,
        coreStateFields.gprs.elementIndex(alias.base),
        alias.bitOffset / 8,
        gprByteLength[alias.width]
      );
    }
    case "segment": {
      const array = segmentArray(channel.field);
      return arrayElementLocation(
        array,
        array.elementIndex(channel.reg),
        0,
        cpuState.layout.array(array).elementByteLength
      );
    }
  }
}

function fieldLocation(field: FieldRef): ResolvedLocation {
  return cpuState.layout.field(field);
}

function arrayElementLocation<TWidth extends LayoutWidth>(
  arrayRef: ArrayRef<TWidth>,
  index: number,
  byteOffset: number,
  byteLength: LayoutByteLength
): ResolvedLocation {
  const array = cpuState.layout.array(arrayRef);

  assert(index < array.count, `state element index ${index} is out of range`);
  return {
    offset: array.offset + index * array.stride + byteOffset,
    byteLength
  };
}

function segmentArray(field: SegmentStateField): ArrayRef<"u16" | "u32", SegmentRegister> {
  switch (field) {
    case "selector":
      return coreStateFields.segmentSelectors;
    case "base":
      return coreStateFields.segmentBases;
    case "limit":
      return coreStateFields.segmentLimits;
    case "access":
      return coreStateFields.segmentAccess;
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
