import { assert } from "#common/assert.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import { functionType } from "#compiler/ir/function.js";
import { functionRef } from "#compiler/ir/refs.js";
import type { ValueId } from "#compiler/ir/values/types.js";
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

const staticRangeType = functionType(["i32", "i32", "i32"], ["i32"]);
const generalRangeType = functionType(["i32", "i32", "i32", "i32"], ["i32"]);

type CrossPageFacts = Readonly<{
  secondPage: ValueId;
  secondEntry: ValueId;
  linearWrapped: ValueId;
  scattered: ValueId;
}>;

// These shared functions receive the first PTE from the caller's page-table
// access. Their captured base table is used only for later pages, so a
// speculative lookup cannot evict the likely-hot first page.
export class ResolutionFunctions {
  readonly #detailedStaticRanges: FunctionFamily<number>;
  readonly #directStaticRanges: FunctionFamily<number>;
  readonly #generalRange: FunctionDefinition;

  constructor(laterEntrySource: PageTableAccess) {
    const effects = {
      reads: [laterEntrySource.effect],
      writes: []
    };

    this.#detailedStaticRanges = new FunctionFamily<number>({
      type: staticRangeType,
      effects: () => effects,
      id: (byteLength) => `memory.virtual.resolve-${byteLength}-byte-range`,
      build: (byteLength, fn) => buildDetailedStaticResolution(fn, byteLength, laterEntrySource)
    });
    this.#directStaticRanges = new FunctionFamily<number>({
      type: staticRangeType,
      effects: () => effects,
      id: (byteLength) => `memory.virtual.resolve-direct-${byteLength}-byte-range`,
      build: (byteLength, fn) => buildDirectStaticResolution(fn, byteLength, laterEntrySource)
    });
    this.#generalRange = new FunctionDefinition({
      ref: functionRef("memory.virtual.resolve-range"),
      type: generalRangeType,
      effects,
      owner: undefined,
      build: (fn) => buildGeneralResolution(fn, laterEntrySource)
    });
  }

  resolveStatic(
    region: RegionBuilder,
    byteLength: number,
    start: ValueId,
    firstEntry: ValueId,
    required: ValueId
  ): ValueId {
    const result = region.call(this.#detailedStaticRanges.get(byteLength), [
      start,
      firstEntry,
      required
    ])[0];

    assert(result !== undefined, "static range resolution is missing");
    return result;
  }

  directStaticUnavailable(
    region: RegionBuilder,
    byteLength: number,
    start: ValueId,
    firstEntry: ValueId,
    required: ValueId
  ): ValueId {
    const result = region.call(this.#directStaticRanges.get(byteLength), [
      start,
      firstEntry,
      required
    ])[0];

    assert(result !== undefined, "direct static range resolution is missing");
    return result;
  }

  resolveGeneral(
    region: RegionBuilder,
    range: LinearRange,
    firstEntry: ValueId,
    required: ValueId
  ): ValueId {
    const result = region.call(this.#generalRange, [
      range.start,
      range.byteLength,
      firstEntry,
      required
    ])[0];

    assert(result !== undefined, "general range resolution is missing");
    return result;
  }
}

// A positive static range no larger than one page reaches at most two pages.
// These helpers are total because an unaligned word or dword can reach them
// without actually crossing a page.
function buildDetailedStaticResolution(
  fn: FunctionBuilder,
  byteLength: number,
  laterEntrySource: PageTableAccess
): void {
  assert(
    byteLength > 0 && byteLength <= virtualPageByteLength,
    "static resolution size must fit within one page"
  );
  const [start, firstEntry, required] = fn.parameters;

  assert(
    start !== undefined && firstEntry !== undefined && required !== undefined,
    "static range parameters are missing"
  );
  const values = fn.values;
  const last = values.binary("add", start, values.const(byteLength - 1));

  fn.region.if(
    values.compare(32, "eq", pageIndex(fn.region, start), pageIndex(fn.region, last)),
    (samePage) => samePage.return([firstEntry]),
    { hint: "likely" }
  );

  const facts = buildCrossPageFacts(fn.region, start, last, firstEntry, laterEntrySource);

  fn.region.if(facts.linearWrapped, (wrapping) => wrapping.return([values.const(0)]), {
    hint: "unlikely"
  });
  fn.region.if(
    entryDeniesAccess(fn.region, firstEntry, required),
    (denied) => denied.return([firstEntry]),
    { hint: "unlikely" }
  );
  fn.region.if(
    entryDeniesAccess(fn.region, facts.secondEntry, required),
    (denied) => denied.return([encodeLaterDenial(denied, facts.secondPage, facts.secondEntry)]),
    { hint: "unlikely" }
  );
  fn.return([encodeSuccessfulResolution(fn.region, firstEntry, facts.scattered)]);
}

function buildDirectStaticResolution(
  fn: FunctionBuilder,
  byteLength: number,
  laterEntrySource: PageTableAccess
): void {
  assert(
    byteLength > 0 && byteLength <= virtualPageByteLength,
    "direct static resolution size must fit within one page"
  );
  const [start, firstEntry, required] = fn.parameters;

  assert(
    start !== undefined && firstEntry !== undefined && required !== undefined,
    "direct static range parameters are missing"
  );
  const values = fn.values;
  const last = values.binary("add", start, values.const(byteLength - 1));
  const samePage = values.compare(
    32,
    "eq",
    pageIndex(fn.region, start),
    pageIndex(fn.region, last)
  );

  fn.region.if(
    samePage,
    (singlePage) => singlePage.return([entryDeniesAccess(singlePage, firstEntry, required)]),
    { hint: "likely" }
  );

  const facts = buildCrossPageFacts(fn.region, start, last, firstEntry, laterEntrySource);
  const denied = entryDeniesAccess(
    fn.region,
    values.binary("and", firstEntry, facts.secondEntry),
    required
  );

  fn.return([
    values.binary("or", facts.linearWrapped, values.binary("or", facts.scattered, denied))
  ]);
}

function buildCrossPageFacts(
  region: RegionBuilder,
  start: ValueId,
  last: ValueId,
  firstEntry: ValueId,
  laterEntrySource: PageTableAccess
): CrossPageFacts {
  const secondPage = pageIndex(region, last);
  const secondEntry = laterEntrySource.read(region, secondPage);

  return {
    secondPage,
    secondEntry,
    linearWrapped: region.values.compare(32, "lt_u", last, start),
    scattered: framesAreNotSequential(region, firstEntry, secondEntry)
  };
}

// The general helper owns empty, wrapping, and arbitrarily large ranges. Its
// packed result preserves the first PTE on success or first-page denial,
// identifies a later denied page, and records any physical discontinuity.
function buildGeneralResolution(fn: FunctionBuilder, laterEntrySource: PageTableAccess): void {
  const [start, byteLength, firstEntry, required] = fn.parameters;

  assert(
    start !== undefined &&
      byteLength !== undefined &&
      firstEntry !== undefined &&
      required !== undefined,
    "general range parameters are missing"
  );
  const values = fn.values;
  const zero = values.const(0);

  fn.region.if(values.compare(32, "eq", byteLength, zero), (empty) => empty.return([zero]), {
    hint: "unlikely"
  });
  const last = values.binary("add", start, values.binary("sub", byteLength, values.const(1)));

  fn.region.if(values.compare(32, "lt_u", last, start), (wrapping) => wrapping.return([zero]), {
    hint: "unlikely"
  });
  const firstPage = pageIndex(fn.region, start);
  const lastPage = pageIndex(fn.region, last);

  fn.region.if(
    values.compare(32, "eq", firstPage, lastPage),
    (singlePage) => singlePage.return([firstEntry]),
    { hint: "likely" }
  );
  fn.region.if(
    entryDeniesAccess(fn.region, firstEntry, required),
    (denied) => denied.return([firstEntry]),
    { hint: "unlikely" }
  );

  const firstFrame = entryFrame(fn.region, firstEntry);
  const expectedSecondFrame = values.binary("add", firstFrame, values.const(virtualPageByteLength));
  const currentPage = values.addLoopInput();
  const expectedFrame = values.addLoopInput();
  const scatteredSoFar = values.addLoopInput();

  fn.region.loop(
    [
      {
        seed: values.binary("add", firstPage, values.const(1)),
        loopInput: currentPage
      },
      {
        seed: expectedSecondFrame,
        loopInput: expectedFrame
      },
      {
        seed: values.compare(32, "lt_u", expectedSecondFrame, firstFrame),
        loopInput: scatteredSoFar
      }
    ],
    (body) => {
      const bodyValues = body.values;
      const currentEntry = laterEntrySource.read(body, currentPage);

      body.if(
        entryDeniesAccess(body, currentEntry, required),
        (denied) => denied.return([encodeLaterDenial(denied, currentPage, currentEntry)]),
        { hint: "unlikely" }
      );
      const currentFrame = entryFrame(body, currentEntry);
      const currentScattered = bodyValues.binary(
        "or",
        scatteredSoFar,
        bodyValues.compare(32, "ne", currentFrame, expectedFrame)
      );

      body.if(bodyValues.compare(32, "eq", currentPage, lastPage), (complete) =>
        complete.return([encodeSuccessfulResolution(complete, firstEntry, currentScattered)])
      );
      const nextExpectedFrame = bodyValues.binary(
        "add",
        currentFrame,
        bodyValues.const(virtualPageByteLength)
      );

      body.loopContinue([
        bodyValues.binary("add", currentPage, bodyValues.const(1)),
        nextExpectedFrame,
        bodyValues.binary(
          "or",
          currentScattered,
          bodyValues.compare(32, "lt_u", nextExpectedFrame, currentFrame)
        )
      ]);
    }
  );
  fn.return([values.unreachable()]);
}

function encodeSuccessfulResolution(
  region: RegionBuilder,
  firstEntry: ValueId,
  scattered: ValueId
): ValueId {
  const marker = region.values.select(
    scattered,
    region.values.const(resolutionResultAttr.SCATTERED),
    region.values.const(0)
  );

  return region.values.binary("or", firstEntry, marker);
}

// The denied page base occupies the frame field so the caller can recover both
// its linear address and the failed entry's presence/writability state.
function encodeLaterDenial(region: RegionBuilder, page: ValueId, entry: ValueId): ValueId {
  const values = region.values;
  const pageBase = values.binary("shl", page, values.const(virtualPageShift));
  const permissions = values.binary(
    "and",
    entry,
    values.const(pageTableEntryAttr.PRESENT | pageTableEntryAttr.WRITABLE)
  );

  return values.binary(
    "or",
    values.binary("or", pageBase, permissions),
    values.const(resolutionResultAttr.LATER_DENIAL)
  );
}

function framesAreNotSequential(
  region: RegionBuilder,
  firstEntry: ValueId,
  secondEntry: ValueId
): ValueId {
  const values = region.values;
  const firstFrame = entryFrame(region, firstEntry);
  const expectedSecondFrame = values.binary("add", firstFrame, values.const(virtualPageByteLength));
  const physicalWrapped = values.compare(32, "lt_u", expectedSecondFrame, firstFrame);

  return values.binary(
    "or",
    physicalWrapped,
    values.compare(32, "ne", entryFrame(region, secondEntry), expectedSecondFrame)
  );
}

function entryFrame(region: RegionBuilder, entry: ValueId): ValueId {
  return region.values.binary("and", entry, region.values.const(pageTableEntryFrameMask));
}

function entryDeniesAccess(region: RegionBuilder, entry: ValueId, required: ValueId): ValueId {
  return region.values.compare(32, "ne", region.values.binary("and", entry, required), required);
}

function pageIndex(region: RegionBuilder, address: ValueId): ValueId {
  return region.values.binary("shr_u", address, region.values.const(virtualPageShift));
}
