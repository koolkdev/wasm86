import { assert } from "#common/assert.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import { functionType } from "#compiler/ir/function.js";
import type { IntegerWidth, ValueId } from "#compiler/ir/values/types.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import type { PhysicalAddressSpaceDefinition } from "../physical.js";
import type { MemoryLoadOptions } from "../types.js";
import { pageTableEntryFrameMask, virtualPageOffsetMask, virtualPageShift } from "./layout.js";
import type { PageTableAccess } from "./page-table.js";

const scatteredReadType = functionType(["i32"], ["i32"]);
const scatteredStoreType = functionType(["i32", "i32"], []);

type ScatteredLoadStoreFunctions = Readonly<{
  reads: FunctionFamily<IntegerWidth>;
  stores: FunctionFamily<IntegerWidth>;
}>;

export type ScatteredLoadStore = Readonly<{
  load(
    region: RegionBuilder,
    linearStart: ValueId,
    width: IntegerWidth,
    options?: MemoryLoadOptions
  ): ValueId;
  store(region: RegionBuilder, linearStart: ValueId, value: ValueId, width: IntegerWidth): void;
}>;

export function createScatteredLoadStore(
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): ScatteredLoadStore {
  const functions = createScatteredLoadStoreFunctions(physical, pageTable);

  return {
    load: (region, linearStart, width, options: MemoryLoadOptions = {}) => {
      const raw = region.call(functions.reads.get(width), [linearStart])[0];

      assert(raw !== undefined, "scattered read result is missing");
      // Helpers return assembled i32 bits; signedness belongs to the requested
      // narrow load and is applied after the bytewise operation.
      return region.values.widthAdjusted(width, raw, options.signed === true);
    },
    store: (region, linearStart, value, width) => {
      region.call(functions.stores.get(width), [linearStart, value]);
    }
  };
}

function createScatteredLoadStoreFunctions(
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): ScatteredLoadStoreFunctions {
  return {
    reads: new FunctionFamily<IntegerWidth>({
      type: scatteredReadType,
      effects: () => ({
        reads: [pageTable.effect, ...physical.effects.reads],
        writes: []
      }),
      id: (width) => `memory.virtual.scattered-read.${width}`,
      build: (width, fn) => buildScatteredRead(fn, width, physical, pageTable)
    }),
    stores: new FunctionFamily<IntegerWidth>({
      type: scatteredStoreType,
      effects: () => ({
        reads: [pageTable.effect],
        writes: physical.effects.writes
      }),
      id: (width) => `memory.virtual.scattered-store.${width}`,
      build: (width, fn) => buildScatteredStore(fn, width, physical, pageTable)
    })
  };
}

function buildScatteredRead(
  fn: FunctionBuilder,
  width: IntegerWidth,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): void {
  const linearStart = fn.parameters[0];

  assert(linearStart !== undefined, "scattered read start is missing");
  const byteLength = width / 8;

  fn.return([readBytes(fn.region, physical, pageTable, linearStart, byteLength)]);
}

function buildScatteredStore(
  fn: FunctionBuilder,
  width: IntegerWidth,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess
): void {
  const linearStart = fn.parameters[0];
  const value = fn.parameters[1];

  assert(linearStart !== undefined, "scattered store start is missing");
  assert(value !== undefined, "scattered store value is missing");
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
  linearStart: ValueId,
  byteLength: number
): ValueId {
  let result = region.values.const(0);

  for (let index = 0; index < byteLength; index += 1) {
    const linearAddress = addByteOffset(region, linearStart, index);
    const byte = readTranslatedByte(region, physical, pageTable, linearAddress);
    const part =
      index === 0 ? byte : region.values.binary("shl", byte, region.values.const(index * 8));

    result = region.values.binary("or", result, part);
  }

  return result;
}

function storeBytes(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearStart: ValueId,
  value: ValueId,
  byteLength: number
): void {
  for (let index = 0; index < byteLength; index += 1) {
    const linearAddress = addByteOffset(region, linearStart, index);
    const byte =
      index === 0 ? value : region.values.binary("shr_u", value, region.values.const(index * 8));

    storeTranslatedByte(region, physical, pageTable, linearAddress, byte);
  }
}

function readTranslatedByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearAddress: ValueId
): ValueId {
  return readPhysicalByte(region, physical, translateAddress(region, linearAddress, pageTable));
}

function storeTranslatedByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  pageTable: PageTableAccess,
  linearAddress: ValueId,
  value: ValueId
): void {
  storePhysicalByte(region, physical, translateAddress(region, linearAddress, pageTable), value);
}

function readPhysicalByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  physicalStart: ValueId
): ValueId {
  const access = physical.access.bind(region);

  return access.load(
    access.issue({
      start: physicalStart,
      byteLength: region.values.const(1)
    }),
    region.values.const(0),
    8
  );
}

function storePhysicalByte(
  region: RegionBuilder,
  physical: PhysicalAddressSpaceDefinition,
  physicalStart: ValueId,
  value: ValueId
): void {
  const access = physical.access.bind(region);

  access.store(
    access.issue({
      start: physicalStart,
      byteLength: region.values.const(1)
    }),
    region.values.const(0),
    value,
    8
  );
}

function pageIndex(region: RegionBuilder, address: ValueId): ValueId {
  return region.values.binary("shr_u", address, region.values.const(virtualPageShift));
}

function translateAddress(
  region: RegionBuilder,
  linearAddress: ValueId,
  pageTable: PageTableAccess
): ValueId {
  return translate(region, linearAddress, pageTable.read(region, pageIndex(region, linearAddress)));
}

function translate(region: RegionBuilder, linearAddress: ValueId, entry: ValueId): ValueId {
  const frame = region.values.binary("and", entry, region.values.const(pageTableEntryFrameMask));
  const offset = region.values.binary(
    "and",
    linearAddress,
    region.values.const(virtualPageOffsetMask)
  );

  return region.values.binary("or", frame, offset);
}

function addByteOffset(region: RegionBuilder, address: ValueId, byteOffset: number): ValueId {
  return byteOffset === 0
    ? address
    : region.values.binary("add", address, region.values.const(byteOffset));
}
