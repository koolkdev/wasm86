import { assert } from "#common/assert.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { LinearRange } from "../types.js";
import {
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  resolutionResultAttr,
  virtualPageByteLength,
  virtualPageOffsetMask,
  virtualPageShift
} from "./layout.js";
import type { PageTableAccess } from "./page-table.js";
import { ResolutionFunctions } from "./resolution-functions.js";

export type RangeResolution = Readonly<{
  denied: ValueId;
  deniedAddress: ValueId;
  deniedPresent: ValueId;
  firstPhysicalStart: ValueId;
  scattered: ValueId;
}>;

export type DirectRangeResolution = Readonly<{
  unavailable: ValueId;
  firstPhysicalStart: ValueId;
}>;

// Resolution helpers return a PTE-shaped word. A normal result preserves the
// first entry, successful scattered ranges add SCATTERED, and a later denial
// stores that page's linear base and permissions with LATER_DENIAL.
export class VirtualRangeResolver {
  readonly #functions: ResolutionFunctions;

  constructor(pageTable: PageTableAccess) {
    this.#functions = new ResolutionFunctions(pageTable);
  }

  resolve(
    region: RegionBuilder,
    range: LinearRange,
    requiredEntryBits: number,
    firstEntrySource: PageTableAccess
  ): RangeResolution {
    const required = region.values.const(requiredEntryBits);
    const resolutionWord = this.#resolveWord(region, range, required, firstEntrySource);

    return decodeRangeResolution(region, range.start, required, resolutionWord);
  }

  resolveDirect(
    region: RegionBuilder,
    range: LinearRange,
    requiredEntryBits: number,
    firstEntrySource: PageTableAccess
  ): DirectRangeResolution {
    const values = region.values;
    const required = values.const(requiredEntryBits);
    const firstEntry = readEntry(region, range.start, firstEntrySource);
    const byteLength = values.constValue(range.byteLength);

    if (byteLength === undefined || byteLength > virtualPageByteLength) {
      const resolutionWord = this.#functions.resolveGeneral(region, range, firstEntry, required);

      return {
        unavailable: directUnavailableFromWord(region, resolutionWord, required, requiredEntryBits),
        firstPhysicalStart: physicalStart(region, resolutionWord, range.start)
      };
    }

    assert(byteLength > 0, "virtual access byte length must be positive");
    const samePageUnavailable = entryDeniesAccess(region, firstEntry, required);
    const unavailable = resolveStaticRange(
      region,
      range.start,
      byteLength,
      samePageUnavailable,
      (helper) =>
        this.#functions.directStaticUnavailable(
          helper,
          byteLength,
          range.start,
          firstEntry,
          required
        )
    );

    return {
      unavailable,
      firstPhysicalStart: physicalStart(region, firstEntry, range.start)
    };
  }

  #resolveWord(
    region: RegionBuilder,
    range: LinearRange,
    required: ValueId,
    firstEntrySource: PageTableAccess
  ): ValueId {
    const values = region.values;
    const firstEntry = readEntry(region, range.start, firstEntrySource);
    const byteLength = values.constValue(range.byteLength);

    if (byteLength === undefined || byteLength > virtualPageByteLength) {
      return this.#functions.resolveGeneral(region, range, firstEntry, required);
    }

    assert(byteLength > 0, "virtual access byte length must be positive");

    return resolveStaticRange(region, range.start, byteLength, firstEntry, (helper) =>
      this.#functions.resolveStatic(helper, byteLength, range.start, firstEntry, required)
    );
  }
}

function resolveStaticRange(
  region: RegionBuilder,
  start: ValueId,
  byteLength: number,
  samePageResult: ValueId,
  callHelper: (region: RegionBuilder) => ValueId
): ValueId {
  if (byteLength === 1) {
    return samePageResult;
  }

  const needsHelper = staticRangeNeedsHelper(region, start, byteLength);
  const known = region.values.constValue(needsHelper);

  if (known === 0) {
    return samePageResult;
  }
  if (known !== undefined) {
    return callHelper(region);
  }

  return region.ifValue(needsHelper, callHelper, () => samePageResult, { hint: "unlikely" });
}

// Natural alignment proves that a word or dword stays on one page. Other
// static sizes use the exact page boundary.
function staticRangeNeedsHelper(
  region: RegionBuilder,
  start: ValueId,
  byteLength: number
): ValueId {
  const values = region.values;

  if (byteLength === 2 || byteLength === 4) {
    return values.binary("and", start, values.const(byteLength - 1));
  }

  const pageOffset = values.binary("and", start, values.const(virtualPageOffsetMask));

  return values.compare(32, "gt_u", pageOffset, values.const(virtualPageByteLength - byteLength));
}

function decodeRangeResolution(
  region: RegionBuilder,
  linearStart: ValueId,
  required: ValueId,
  resolutionWord: ValueId
): RangeResolution {
  const values = region.values;
  const laterDenial = values.binary(
    "and",
    resolutionWord,
    values.const(resolutionResultAttr.LATER_DENIAL)
  );

  return {
    denied: entryDeniesAccess(region, resolutionWord, required),
    deniedAddress: values.select(
      laterDenial,
      values.binary("and", resolutionWord, values.const(pageTableEntryFrameMask)),
      linearStart
    ),
    deniedPresent: values.binary("and", resolutionWord, values.const(pageTableEntryAttr.PRESENT)),
    firstPhysicalStart: physicalStart(region, resolutionWord, linearStart),
    scattered: values.binary("and", resolutionWord, values.const(resolutionResultAttr.SCATTERED))
  };
}

function directUnavailableFromWord(
  region: RegionBuilder,
  resolutionWord: ValueId,
  required: ValueId,
  requiredEntryBits: number
): ValueId {
  const directBits =
    requiredEntryBits | resolutionResultAttr.LATER_DENIAL | resolutionResultAttr.SCATTERED;

  return region.values.compare(
    32,
    "ne",
    region.values.binary("and", resolutionWord, region.values.const(directBits)),
    required
  );
}

function entryDeniesAccess(region: RegionBuilder, entry: ValueId, required: ValueId): ValueId {
  return region.values.compare(32, "ne", region.values.binary("and", entry, required), required);
}

function readEntry(region: RegionBuilder, address: ValueId, pageTable: PageTableAccess): ValueId {
  const page = region.values.binary("shr_u", address, region.values.const(virtualPageShift));

  return pageTable.read(region, page);
}

function physicalStart(region: RegionBuilder, entry: ValueId, linearStart: ValueId): ValueId {
  const values = region.values;

  return values.binary(
    "or",
    values.binary("and", entry, values.const(pageTableEntryFrameMask)),
    values.binary("and", linearStart, values.const(virtualPageOffsetMask))
  );
}
