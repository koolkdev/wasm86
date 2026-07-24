import { assert } from "#common/assert.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { LinearRange } from "../types.js";
import {
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  virtualPageOffsetMask,
  virtualPageShift
} from "./layout.js";
import type { PageTableAccess } from "./page-table.js";
import {
  createPageWalk,
  type PageWalk,
  type ResolutionWord
} from "./page-walk.js";

export type RangeResolution = Readonly<{
  denied: ValueId;
  deniedAddress: ValueId;
  deniedPresent: ValueId;
  firstPhysicalStart: ValueId;
  scattered: ValueId;
}>;

export type RangeResolver = Readonly<{
  resolve(
    region: RegionBuilder,
    range: LinearRange,
    required: ValueId
  ): RangeResolution;
}>;

export function createRangeResolver(
  pageTable: PageTableAccess
): RangeResolver {
  const pageWalk = createPageWalk(pageTable);

  return {
    resolve: (region, range, required) =>
      resolveRange(region, range, required, pageTable, pageWalk)
  };
}

function resolveRange(
  region: RegionBuilder,
  range: LinearRange,
  required: ValueId,
  pageTable: PageTableAccess,
  pageWalk: PageWalk
): RangeResolution {
  const result = selectResolutionWord(
    region,
    range,
    required,
    pageTable,
    pageWalk
  );
  const values = region.values;
  const word = result.word;

  return {
    denied: values.compare(
      32,
      "ne",
      values.binary("and", word, required),
      required
    ),
    deniedAddress: values.select(
      result.laterDenial,
      values.binary(
        "and",
        word,
        values.const(pageTableEntryFrameMask)
      ),
      range.start
    ),
    deniedPresent: values.binary(
      "and",
      word,
      values.const(pageTableEntryAttr.PRESENT)
    ),
    firstPhysicalStart: values.binary(
      "or",
      values.binary(
        "and",
        word,
        values.const(pageTableEntryFrameMask)
      ),
      values.binary(
        "and",
        range.start,
        values.const(virtualPageOffsetMask)
      )
    ),
    scattered: result.scattered
  };
}

function selectResolutionWord(
  region: RegionBuilder,
  range: LinearRange,
  required: ValueId,
  pageTable: PageTableAccess,
  pageWalk: PageWalk
): ResolutionWord {
  const values = region.values;
  const staticByteLength = values.constValue(range.byteLength);

  assert(
    staticByteLength === undefined || staticByteLength !== 0,
    "virtual access byte length must be nonzero"
  );

  if (staticByteLength === 1) {
    return singlePageResult(region, range.start, pageTable);
  }
  if (staticByteLength === 2 || staticByteLength === 4) {
    // Because 2 and 4 divide the 4-KiB page size, a naturally aligned word or
    // dword cannot cross a page. Its permission and frame need only one PTE.
    const misaligned = values.binary(
      "and",
      range.start,
      values.const(staticByteLength - 1)
    );
    const staticMisaligned = values.constValue(misaligned);

    if (staticMisaligned !== undefined) {
      return staticMisaligned === 0
        ? singlePageResult(region, range.start, pageTable)
        : walkRange(region, range, required, pageWalk);
    }
    const word = region.ifValue(
      misaligned,
      (slow) => pageWalk.call(slow, range, required),
      (fast) => readEntry(fast, range.start, pageTable),
      { hint: "unlikely" }
    );

    return pageWalk.decodeWord(region, word);
  }

  return walkRange(region, range, required, pageWalk);
}

function singlePageResult(
  region: RegionBuilder,
  address: ValueId,
  pageTable: PageTableAccess
): ResolutionWord {
  // Keep these route facts literal. Decoding them from a dynamic PTE would hide
  // the proof that a one-page access has no later denial or scattered frame run.
  return {
    word: readEntry(region, address, pageTable),
    laterDenial: region.values.const(0),
    scattered: region.values.const(0)
  };
}

function walkRange(
  region: RegionBuilder,
  range: LinearRange,
  required: ValueId,
  pageWalk: PageWalk
): ResolutionWord {
  return pageWalk.decodeWord(
    region,
    pageWalk.call(region, range, required)
  );
}

function readEntry(
  region: RegionBuilder,
  address: ValueId,
  pageTable: PageTableAccess
): ValueId {
  const page = region.values.binary(
    "shr_u",
    address,
    region.values.const(virtualPageShift)
  );

  return pageTable.read(region, page);
}
