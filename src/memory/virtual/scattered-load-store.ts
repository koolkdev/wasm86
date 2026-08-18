import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { FunctionBuilder } from "#compiler/function/builder/function.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, i32, type I32Value } from "#compiler/function/values.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import type { PhysicalAddressSpaceDefinition } from "../physical.js";
import type { MemoryTransferWidth } from "../types.js";
import { pageTableEntryFrameMask, virtualPageOffsetMask, virtualPageShift } from "./layout.js";
import type { PageTableAccess } from "./page-table.js";

const scatteredReadType = functionType([Integer[32]], [Integer[32]]);
const scatteredStoreType = functionType([Integer[32], Integer[32]], []);
type ScatteredInteger = Integer<8> | Integer<16> | Integer<32>;

type ScatteredLoadStoreFunctions = Readonly<{
  reads: FunctionFamily<MemoryTransferWidth, typeof scatteredReadType>;
  stores: FunctionFamily<MemoryTransferWidth, typeof scatteredStoreType>;
}>;

export type ScatteredLoadStore = Readonly<{
  load<Width extends MemoryTransferWidth>(
    region: RegionBuilder,
    linearStart: I32Value,
    width: Width
  ): Integer<Width>;
  store<Width extends MemoryTransferWidth>(
    region: RegionBuilder,
    linearStart: I32Value,
    value: Integer<Width>
  ): void;
}>;

export function createScatteredLoadStore(
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): ScatteredLoadStore {
  const functions = createScatteredLoadStoreFunctions(physical, pageTable);

  return {
    load: (region, linearStart, width) => loadScattered(region, linearStart, width, functions),
    store: (region, linearStart, value) => storeScattered(region, linearStart, value, functions)
  };
}

function loadScattered<Width extends MemoryTransferWidth>(
  region: RegionBuilder,
  linearStart: I32Value,
  width: Width,
  functions: ScatteredLoadStoreFunctions
): Integer<Width>;
function loadScattered(
  region: RegionBuilder,
  linearStart: I32Value,
  width: MemoryTransferWidth,
  functions: ScatteredLoadStoreFunctions
): ScatteredInteger {
  switch (width) {
    case 8: {
      const [value] = region.call(functions.reads.get(width), [linearStart]);

      return value.truncate(width);
    }
    case 16: {
      const [value] = region.call(functions.reads.get(width), [linearStart]);

      return value.truncate(width);
    }
    case 32: {
      const [value] = region.call(functions.reads.get(width), [linearStart]);

      return value;
    }
  }
}

function storeScattered<Width extends MemoryTransferWidth>(
  region: RegionBuilder,
  linearStart: I32Value,
  value: Integer<Width>,
  functions: ScatteredLoadStoreFunctions
): void;
function storeScattered(
  region: RegionBuilder,
  linearStart: I32Value,
  value: ScatteredInteger,
  functions: ScatteredLoadStoreFunctions
): void {
  switch (value.width) {
    case 8:
      region.call(functions.stores.get(value.width), [linearStart, value.unsigned.extend(32)]);
      return;
    case 16:
      region.call(functions.stores.get(value.width), [linearStart, value.unsigned.extend(32)]);
      return;
    case 32:
      region.call(functions.stores.get(value.width), [linearStart, value]);
      return;
  }
}

function createScatteredLoadStoreFunctions(
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): ScatteredLoadStoreFunctions {
  return {
    reads: new FunctionFamily({
      type: scatteredReadType,
      effects: (_width: MemoryTransferWidth) => ({
        reads: [pageTable.effect, ...physical.effects.reads],
        writes: []
      }),
      id: (width) => `memory.virtual.scattered-read.${width}`,
      build: (width, fn) => buildScatteredRead(fn, width, physical, pageTable)
    }),
    stores: new FunctionFamily({
      type: scatteredStoreType,
      effects: (_width: MemoryTransferWidth) => ({
        reads: [pageTable.effect],
        writes: physical.effects.writes
      }),
      id: (width) => `memory.virtual.scattered-store.${width}`,
      build: (width, fn) => buildScatteredStore(fn, width, physical, pageTable)
    })
  };
}

function buildScatteredRead(
  fn: FunctionBuilder<typeof scatteredReadType>,
  width: MemoryTransferWidth,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): void {
  const [linearStart] = fn.parameters;
  const byteLength = width / 8;

  fn.return([readBytes(fn.region, physical, pageTable, linearStart, byteLength)]);
}

function buildScatteredStore(
  fn: FunctionBuilder<typeof scatteredStoreType>,
  width: MemoryTransferWidth,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): void {
  const [linearStart, value] = fn.parameters;
  const byteLength = width / 8;

  storeBytes(fn.region, physical, pageTable, linearStart, value, byteLength);
  fn.return([]);
}

// The range walk has already checked every touched PTE, and Virtual exposes no
// generated PTE writer. The bytewise helpers below therefore reread entries
// only to recover frames; they intentionally do not repeat permission checks.
function readBytes(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearStart: I32Value,
  byteLength: number
): I32Value {
  let result = i32(0);

  for (let index = 0; index < byteLength; index += 1) {
    const linearAddress = addByteOffset(linearStart, index);
    const byte = readTranslatedByte(region, physical, pageTable, linearAddress);
    const extended = byte.unsigned.extend(32);
    const part = index === 0 ? extended : extended.shl(index * 8);

    result = result.or(part);
  }

  return result;
}

function storeBytes(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearStart: I32Value,
  value: I32Value,
  byteLength: number
): void {
  for (let index = 0; index < byteLength; index += 1) {
    const linearAddress = addByteOffset(linearStart, index);
    const byte = (index === 0 ? value : value.unsigned.shr(index * 8)).truncate(8);

    storeTranslatedByte(region, physical, pageTable, linearAddress, byte);
  }
}

function readTranslatedByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearAddress: I32Value
): Integer<8> {
  return readPhysicalByte(region, physical, translateAddress(region, linearAddress, pageTable));
}

function storeTranslatedByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearAddress: I32Value,
  value: Integer<8>
): void {
  storePhysicalByte(region, physical, translateAddress(region, linearAddress, pageTable), value);
}

function readPhysicalByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  physicalStart: I32Value
): Integer<8> {
  const access = physical.access.forRegion(region);

  return access.load(
    access.issue({
      start: physicalStart,
      byteLength: i32(1)
    }),
    i32(0),
    8
  );
}

function storePhysicalByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  physicalStart: I32Value,
  value: Integer<8>
): void {
  const access = physical.access.forRegion(region);

  access.store(
    access.issue({
      start: physicalStart,
      byteLength: i32(1)
    }),
    i32(0),
    value
  );
}

function pageIndex(address: I32Value): Integer<32> {
  return address.unsigned.shr(virtualPageShift);
}

function translateAddress(
  region: RegionBuilder,
  linearAddress: I32Value,
  pageTable: PageTableAccess
): I32Value {
  return translate(linearAddress, pageTable.read(region, pageIndex(linearAddress)));
}

function translate(linearAddress: I32Value, entry: I32Value): I32Value {
  const frame = entry.and(pageTableEntryFrameMask);
  const offset = linearAddress.and(virtualPageOffsetMask);

  return frame.or(offset);
}

function addByteOffset(address: I32Value, byteOffset: number): I32Value {
  return byteOffset === 0 ? address : address.add(byteOffset);
}
