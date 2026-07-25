import { assert } from "#common/assert.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import { functionType } from "#compiler/ir/function.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import type { LinearRange } from "../types.js";
import {
  pageWalkResultAttr,
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  virtualPageByteLength,
  virtualPageShift
} from "./layout.js";
import type { PageTableAccess } from "./page-table.js";

const pageWalkType = functionType(
  ["i32", "i32", "i32"],
  ["i32"]
);

type PageWalkFamily = FunctionFamily<"range">;

export type ResolutionWord = Readonly<{
  word: ValueId;
  laterDenial: ValueId;
  scattered: ValueId;
}>;

export type PageWalk = Readonly<{
  call(
    region: RegionBuilder,
    range: LinearRange,
    required: ValueId
  ): ValueId;
  decodeWord(region: RegionBuilder, word: ValueId): ResolutionWord;
}>;

export function createPageWalk(
  pageTable: PageTableAccess
): PageWalk {
  const functions = createPageWalkFunctions(pageTable);

  return {
    call: (region, range, required) => {
      const result = region.call(
        functions.get("range"),
        [range.start, range.byteLength, required]
      )[0];

      assert(result !== undefined, "virtual page walk result is missing");
      return result;
    },
    decodeWord: (region, word) => ({
      word,
      laterDenial: region.values.binary(
        "and",
        word,
        region.values.const(pageWalkResultAttr.LATER_DENIAL)
      ),
      scattered: region.values.binary(
        "and",
        word,
        region.values.const(pageWalkResultAttr.SCATTERED)
      )
    })
  };
}

function createPageWalkFunctions(
  pageTable: PageTableAccess
): PageWalkFamily {
  return new FunctionFamily<"range">({
    type: pageWalkType,
    effects: () => ({
      reads: [pageTable.effect],
      writes: []
    }),
    id: () => "memory.virtual.page-walk",
    build: (_key, fn) => buildPageWalk(fn, pageTable)
  });
}

// The generated walk returns one PTE-shaped word. Success and a first-page
// denial keep the first PTE. A later denial replaces the frame with the denied
// linear page base and keeps that entry's P/W bits. Successful discontinuous
// frames add SCATTERED; zero represents an empty or wrapping range.
function buildPageWalk(
  fn: FunctionBuilder,
  pageTable: PageTableAccess
): void {
  const start = fn.parameters[0];
  const byteLength = fn.parameters[1];
  const required = fn.parameters[2];

  assert(start !== undefined, "virtual range start is missing");
  assert(byteLength !== undefined, "virtual range byte length is missing");
  assert(required !== undefined, "virtual range required bits are missing");
  const values = fn.values;
  const zero = values.const(0);
  const one = values.const(1);
  const lengthMinusOne = values.binary("sub", byteLength, one);
  const last = values.binary("add", start, lengthMinusOne);

  fn.region.if(
    values.compare(32, "eq", byteLength, zero),
    (denied) => denied.return([zero]),
    { hint: "unlikely" }
  );
  // Linear ranges stop at 0xffff_ffff; they never wrap through address zero.
  fn.region.if(
    values.compare(32, "lt_u", last, start),
    (denied) => denied.return([zero]),
    { hint: "unlikely" }
  );
  const firstPage = pageIndex(fn.region, start);
  const lastPage = pageIndex(fn.region, last);
  const firstEntry = pageTable.read(fn.region, firstPage);

  // Misaligned scalars and dynamic ranges may still end in their first page.
  // Return after its PTE rather than entering the multi-page walk.
  fn.region.if(
    values.compare(32, "eq", firstPage, lastPage),
    (singlePage) => singlePage.return([firstEntry]),
    { hint: "likely" }
  );
  fn.region.if(
    entryDenied(fn.region, firstEntry, required),
    (denied) => denied.return([firstEntry]),
    { hint: "unlikely" }
  );
  const firstFrame = values.binary(
    "and",
    firstEntry,
    values.const(pageTableEntryFrameMask)
  );
  // i32 frame arithmetic can wrap, but one Physical access cannot span the
  // 4-GiB boundary. Treat that run as scattered even when frames appear adjacent.
  const expectedFrame = values.binary(
    "add",
    firstFrame,
    values.const(virtualPageByteLength)
  );
  const page = values.addLoopInput();
  const expected = values.addLoopInput();
  const scattered = values.addLoopInput();

  fn.region.loop([
    {
      seed: values.binary("add", firstPage, one),
      loopInput: page
    },
    {
      seed: expectedFrame,
      loopInput: expected
    },
    {
      seed: values.compare(
        32,
        "lt_u",
        expectedFrame,
        firstFrame
      ),
      loopInput: scattered
    }
  ], (body) => {
    const bodyValues = body.values;
    const entry = pageTable.read(body, page);

    body.if(
      entryDenied(body, entry, required),
      (denied) => {
        const deniedValues = denied.values;
        const pageBase = deniedValues.binary(
          "shl",
          page,
          deniedValues.const(virtualPageShift)
        );
        const permissions = deniedValues.binary(
          "and",
          entry,
          deniedValues.const(
            pageTableEntryAttr.PRESENT |
            pageTableEntryAttr.WRITABLE
          )
        );

        // The denied page base occupies the otherwise-frame field so the caller
        // can recover both the fault address and this entry's P/W state.
        denied.return([
          deniedValues.binary(
            "or",
            deniedValues.binary("or", pageBase, permissions),
            deniedValues.const(pageWalkResultAttr.LATER_DENIAL)
          )
        ]);
      },
      { hint: "unlikely" }
    );
    const frame = bodyValues.binary(
      "and",
      entry,
      bodyValues.const(pageTableEntryFrameMask)
    );
    const currentScattered = bodyValues.binary(
      "or",
      scattered,
      bodyValues.compare(32, "ne", frame, expected)
    );

    body.if(
      bodyValues.compare(32, "eq", page, lastPage),
      (complete) => {
        const completeValues = complete.values;
        const marker = completeValues.select(
          currentScattered,
          completeValues.const(pageWalkResultAttr.SCATTERED),
          completeValues.const(0)
        );

        complete.return([
          completeValues.binary("or", firstEntry, marker)
        ]);
      }
    );
    const nextExpected = bodyValues.binary(
      "add",
      frame,
      bodyValues.const(virtualPageByteLength)
    );
    const physicalWrapped = bodyValues.compare(
      32,
      "lt_u",
      nextExpected,
      frame
    );

    body.loopContinue([
      bodyValues.binary("add", page, bodyValues.const(1)),
      nextExpected,
      bodyValues.binary(
        "or",
        currentScattered,
        physicalWrapped
      )
    ]);
  });
  fn.return([values.unreachable()]);
}

function entryDenied(
  region: RegionBuilder,
  entry: ValueId,
  required: ValueId
): ValueId {
  return region.values.compare(
    32,
    "ne",
    region.values.binary("and", entry, required),
    required
  );
}

function pageIndex(
  region: RegionBuilder,
  address: ValueId
): ValueId {
  return region.values.binary(
    "shr_u",
    address,
    region.values.const(virtualPageShift)
  );
}
