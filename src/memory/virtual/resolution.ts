import { assert } from "#common/assert.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import {
  i32,
  nonzero,
  select,
  type Integer,
  type BitValue,
  type I32Value
} from "#compiler/function/values.js";
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
  denied: BitValue;
  deniedAddress: I32Value;
  deniedPresent: I32Value;
  firstPhysicalStart: I32Value;
  scattered: BitValue;
}>;

export type DirectRangeResolution = Readonly<{
  unavailable: BitValue;
  firstPhysicalStart: I32Value;
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
    const required = i32(requiredEntryBits);
    const resolutionWord = this.#resolveWord(region, range, required, firstEntrySource);

    return decodeRangeResolution(range.start, required, resolutionWord);
  }

  resolveDirect(
    region: RegionBuilder,
    range: LinearRange,
    requiredEntryBits: number,
    firstEntrySource: PageTableAccess
  ): DirectRangeResolution {
    const required = i32(requiredEntryBits);
    const firstEntry = readEntry(region, range.start, firstEntrySource);
    const byteLength = region.constValue(range.byteLength);

    if (byteLength === undefined || byteLength > virtualPageByteLength) {
      const resolutionWord = this.#functions.resolveGeneral(region, range, firstEntry, required);

      return {
        unavailable: directUnavailableFromWord(resolutionWord, required, requiredEntryBits),
        firstPhysicalStart: physicalStart(resolutionWord, range.start)
      };
    }

    assert(byteLength > 0, "virtual access byte length must be positive");
    const samePageUnavailable = entryDeniesAccess(firstEntry, required);
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
      firstPhysicalStart: physicalStart(firstEntry, range.start)
    };
  }

  #resolveWord(
    region: RegionBuilder,
    range: LinearRange,
    required: I32Value,
    firstEntrySource: PageTableAccess
  ): I32Value {
    const firstEntry = readEntry(region, range.start, firstEntrySource);
    const byteLength = region.constValue(range.byteLength);

    if (byteLength === undefined || byteLength > virtualPageByteLength) {
      return this.#functions.resolveGeneral(region, range, firstEntry, required);
    }

    assert(byteLength > 0, "virtual access byte length must be positive");

    return resolveStaticRange(region, range.start, byteLength, firstEntry, (helper) =>
      this.#functions.resolveStatic(helper, byteLength, range.start, firstEntry, required)
    );
  }
}

function resolveStaticRange<Width extends IntegerWidth>(
  region: RegionBuilder,
  start: I32Value,
  byteLength: number,
  samePageResult: Integer<Width>,
  callHelper: (region: RegionBuilder) => Integer<NoInfer<Width>>
): Integer<Width> {
  if (byteLength === 1) {
    return samePageResult;
  }

  const needsHelper = staticRangeNeedsHelper(start, byteLength);
  const known = region.constValue(needsHelper);

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
function staticRangeNeedsHelper(start: I32Value, byteLength: number): BitValue {
  if (byteLength === 2 || byteLength === 4) {
    return nonzero(start.and(byteLength - 1));
  }

  const pageOffset = start.and(virtualPageOffsetMask);

  return pageOffset.unsigned.gt(virtualPageByteLength - byteLength);
}

function decodeRangeResolution(
  linearStart: I32Value,
  required: I32Value,
  resolutionWord: I32Value
): RangeResolution {
  const laterDenial = resolutionWord.and(resolutionResultAttr.LATER_DENIAL);

  return {
    denied: entryDeniesAccess(resolutionWord, required),
    deniedAddress: select(
      nonzero(laterDenial),
      resolutionWord.and(pageTableEntryFrameMask),
      linearStart
    ),
    deniedPresent: resolutionWord.and(pageTableEntryAttr.PRESENT),
    firstPhysicalStart: physicalStart(resolutionWord, linearStart),
    scattered: nonzero(resolutionWord.and(resolutionResultAttr.SCATTERED))
  };
}

function directUnavailableFromWord(
  resolutionWord: I32Value,
  required: I32Value,
  requiredEntryBits: number
): BitValue {
  const directBits =
    requiredEntryBits | resolutionResultAttr.LATER_DENIAL | resolutionResultAttr.SCATTERED;

  return resolutionWord.and(directBits).ne(required);
}

function entryDeniesAccess(entry: I32Value, required: I32Value): BitValue {
  return entry.and(required).ne(required);
}

function readEntry(region: RegionBuilder, address: I32Value, pageTable: PageTableAccess): I32Value {
  const page = address.unsigned.shr(virtualPageShift);

  return pageTable.read(region, page);
}

function physicalStart(entry: I32Value, linearStart: I32Value): I32Value {
  return entry.and(pageTableEntryFrameMask).or(linearStart.and(virtualPageOffsetMask));
}
