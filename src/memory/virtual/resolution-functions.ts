import { assert } from "#common/assert.js";
import type { FunctionBuilder } from "#compiler/function/builder/function.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import { functionType } from "#compiler/function/type.js";
import {
  Integer,
  i32,
  select,
  unreachable,
  type BitValue,
  type I32Value
} from "#compiler/function/values.js";
import { functionRef } from "#compiler/reference.js";
import { FunctionDefinition, FunctionFamily } from "#compiler/program/functions.js";
import type { LinearRange } from "../types.js";
import {
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  resolutionResultAttr,
  virtualPageByteLength,
  virtualPageShift
} from "./layout.js";
import type { PageTableAccess } from "./page-table.js";

const staticRangeType = functionType([Integer[32], Integer[32], Integer[32]], [Integer[32]]);
const directStaticRangeType = functionType([Integer[32], Integer[32], Integer[32]], [Integer[1]]);
const generalRangeType = functionType(
  [Integer[32], Integer[32], Integer[32], Integer[32]],
  [Integer[32]]
);

type CrossPageFacts = Readonly<{
  secondPage: Integer<32>;
  secondEntry: I32Value;
  linearWrapped: BitValue;
  scattered: BitValue;
}>;

// These shared functions receive the first PTE from the caller's page-table
// access. Their captured base table is used only for later pages, so a
// speculative lookup cannot evict the likely-hot first page.
export class ResolutionFunctions {
  readonly #detailedStaticRanges: FunctionFamily<number, typeof staticRangeType>;
  readonly #directStaticRanges: FunctionFamily<number, typeof directStaticRangeType>;
  readonly #generalRange: FunctionDefinition<typeof generalRangeType>;

  constructor(laterEntrySource: PageTableAccess) {
    const effects = {
      reads: [laterEntrySource.effect],
      writes: []
    };

    this.#detailedStaticRanges = new FunctionFamily({
      type: staticRangeType,
      effects: (_byteLength: number) => effects,
      id: (byteLength) => `memory.virtual.resolve-${byteLength}-byte-range`,
      build: (byteLength, fn) => buildDetailedStaticResolution(fn, byteLength, laterEntrySource)
    });
    this.#directStaticRanges = new FunctionFamily({
      type: directStaticRangeType,
      effects: (_byteLength: number) => effects,
      id: (byteLength) => `memory.virtual.resolve-direct-${byteLength}-byte-range`,
      build: (byteLength, fn) => buildDirectStaticResolution(fn, byteLength, laterEntrySource)
    });
    this.#generalRange = new FunctionDefinition({
      ref: functionRef("memory.virtual.resolve-range"),
      type: generalRangeType,
      effects,
      owner: undefined,
      buildStability: "stable",
      build: (fn) => buildGeneralResolution(fn, laterEntrySource)
    });
  }

  resolveStatic(
    region: RegionBuilder,
    byteLength: number,
    start: I32Value,
    firstEntry: I32Value,
    required: I32Value
  ): I32Value {
    const [result] = region.call(this.#detailedStaticRanges.get(byteLength), [
      start,
      firstEntry,
      required
    ]);
    return result;
  }

  directStaticUnavailable(
    region: RegionBuilder,
    byteLength: number,
    start: I32Value,
    firstEntry: I32Value,
    required: I32Value
  ): BitValue {
    const [result] = region.call(this.#directStaticRanges.get(byteLength), [
      start,
      firstEntry,
      required
    ]);
    return result;
  }

  resolveGeneral(
    region: RegionBuilder,
    range: LinearRange,
    firstEntry: I32Value,
    required: I32Value
  ): I32Value {
    const [result] = region.call(this.#generalRange, [
      range.start,
      range.byteLength,
      firstEntry,
      required
    ]);
    return result;
  }
}

// A positive static range no larger than one page reaches at most two pages.
// These helpers are total because an unaligned word or dword can reach them
// without actually crossing a page.
function buildDetailedStaticResolution(
  fn: FunctionBuilder<typeof staticRangeType>,
  byteLength: number,
  laterEntrySource: PageTableAccess
): void {
  assert(
    byteLength > 0 && byteLength <= virtualPageByteLength,
    "static resolution size must fit within one page"
  );
  const [start, firstEntry, required] = fn.parameters;
  const last = start.add(byteLength - 1);

  fn.region.if(pageIndex(start).eq(pageIndex(last)), (samePage) => samePage.return([firstEntry]), {
    hint: "likely"
  });

  const facts = buildCrossPageFacts(fn.region, start, last, firstEntry, laterEntrySource);

  fn.region.if(facts.linearWrapped, (wrapping) => wrapping.return([i32(0)]), { hint: "unlikely" });
  fn.region.if(entryDeniesAccess(firstEntry, required), (denied) => denied.return([firstEntry]), {
    hint: "unlikely"
  });
  fn.region.if(
    entryDeniesAccess(facts.secondEntry, required),
    (denied) => denied.return([encodeLaterDenial(facts.secondPage, facts.secondEntry)]),
    { hint: "unlikely" }
  );
  fn.return([encodeSuccessfulResolution(firstEntry, facts.scattered)]);
}

function buildDirectStaticResolution(
  fn: FunctionBuilder<typeof directStaticRangeType>,
  byteLength: number,
  laterEntrySource: PageTableAccess
): void {
  assert(
    byteLength > 0 && byteLength <= virtualPageByteLength,
    "direct static resolution size must fit within one page"
  );
  const [start, firstEntry, required] = fn.parameters;
  const last = start.add(byteLength - 1);
  const samePage = pageIndex(start).eq(pageIndex(last));

  fn.region.if(
    samePage,
    (singlePage) => singlePage.return([entryDeniesAccess(firstEntry, required)]),
    { hint: "likely" }
  );

  const facts = buildCrossPageFacts(fn.region, start, last, firstEntry, laterEntrySource);
  const denied = entryDeniesAccess(firstEntry.and(facts.secondEntry), required);

  fn.return([facts.linearWrapped.or(facts.scattered.or(denied))]);
}

function buildCrossPageFacts(
  region: RegionBuilder,
  start: I32Value,
  last: I32Value,
  firstEntry: I32Value,
  laterEntrySource: PageTableAccess
): CrossPageFacts {
  const secondPage = pageIndex(last);
  const secondEntry = laterEntrySource.read(region, secondPage);

  return {
    secondPage,
    secondEntry,
    linearWrapped: last.unsigned.lt(start),
    scattered: framesAreNotSequential(firstEntry, secondEntry)
  };
}

// The general helper owns empty, wrapping, and arbitrarily large ranges. Its
// packed result preserves the first PTE on success or first-page denial,
// identifies a later denied page, and records any physical discontinuity.
function buildGeneralResolution(
  fn: FunctionBuilder<typeof generalRangeType>,
  laterEntrySource: PageTableAccess
): void {
  const [start, byteLength, firstEntry, required] = fn.parameters;
  fn.region.if(byteLength.eq(0), (empty) => empty.return([i32(0)]), { hint: "unlikely" });
  const last = start.add(byteLength.sub(1));

  fn.region.if(last.unsigned.lt(start), (wrapping) => wrapping.return([i32(0)]), {
    hint: "unlikely"
  });
  const firstPage = pageIndex(start);
  const lastPage = pageIndex(last);

  fn.region.if(firstPage.eq(lastPage), (singlePage) => singlePage.return([firstEntry]), {
    hint: "likely"
  });
  fn.region.if(entryDeniesAccess(firstEntry, required), (denied) => denied.return([firstEntry]), {
    hint: "unlikely"
  });

  buildGeneralResolutionLoop(
    fn.region,
    laterEntrySource,
    firstPage,
    lastPage,
    firstEntry,
    required
  );
  fn.return([unreachable()]);
}

function buildGeneralResolutionLoop(
  region: RegionBuilder,
  laterEntrySource: PageTableAccess,
  firstPage: Integer<32>,
  lastPage: Integer<32>,
  firstEntry: I32Value,
  required: I32Value
): void {
  const firstFrame = entryFrame(firstEntry);
  const expectedSecondFrame = firstFrame.add(virtualPageByteLength);
  region.loop(
    [firstPage.add(1), expectedSecondFrame, expectedSecondFrame.unsigned.lt(firstFrame)],
    (body, [currentPage, expectedFrame, scatteredSoFar]) => {
      const currentEntry = laterEntrySource.read(body, currentPage);

      body.if(
        entryDeniesAccess(currentEntry, required),
        (denied) => denied.return([encodeLaterDenial(currentPage, currentEntry)]),
        { hint: "unlikely" }
      );
      const currentFrame = entryFrame(currentEntry);
      const currentScattered = scatteredSoFar.or(currentFrame.ne(expectedFrame));

      body.if(currentPage.eq(lastPage), (complete) =>
        complete.return([encodeSuccessfulResolution(firstEntry, currentScattered)])
      );
      const nextExpectedFrame = currentFrame.add(virtualPageByteLength);
      body.loopContinue([
        currentPage.add(1),
        nextExpectedFrame,
        currentScattered.or(nextExpectedFrame.unsigned.lt(currentFrame))
      ]);
    }
  );
}

function encodeSuccessfulResolution(firstEntry: I32Value, scattered: BitValue): I32Value {
  const marker = select(scattered, i32(resolutionResultAttr.SCATTERED), i32(0));

  return firstEntry.or(marker);
}

// The denied page base occupies the frame field so the caller can recover both
// its linear address and the failed entry's presence/writability state.
function encodeLaterDenial(page: Integer<32>, entry: I32Value): I32Value {
  const pageBase = page.shl(virtualPageShift);
  const permissions = entry.and(pageTableEntryAttr.PRESENT | pageTableEntryAttr.WRITABLE);

  return pageBase.or(permissions).or(resolutionResultAttr.LATER_DENIAL);
}

function framesAreNotSequential(firstEntry: I32Value, secondEntry: I32Value): BitValue {
  const firstFrame = entryFrame(firstEntry);
  const expectedSecondFrame = firstFrame.add(virtualPageByteLength);
  const physicalWrapped = expectedSecondFrame.unsigned.lt(firstFrame);

  return physicalWrapped.or(entryFrame(secondEntry).ne(expectedSecondFrame));
}

function entryFrame(entry: I32Value): Integer<32> {
  return entry.and(pageTableEntryFrameMask);
}

function entryDeniesAccess(entry: I32Value, required: I32Value): BitValue {
  return entry.and(required).ne(required);
}

function pageIndex(address: I32Value): Integer<32> {
  return address.unsigned.shr(virtualPageShift);
}
