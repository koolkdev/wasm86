import { strictEqual } from "node:assert";
import { test } from "node:test";

import {
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  resolutionResultAttr,
  virtualPageByteLength,
  virtualPageCount,
  virtualPageOffsetMask,
  virtualPageShift
} from "#memory/virtual/layout.js";

test("Virtual defines x86 page geometry and the stored PTE encoding", () => {
  strictEqual(virtualPageShift, 12);
  strictEqual(virtualPageByteLength, 0x1000);
  strictEqual(virtualPageCount, 0x10_0000);
  strictEqual(virtualPageOffsetMask, 0x0fff);
  strictEqual(pageTableEntryAttr.PRESENT, 1);
  strictEqual(pageTableEntryAttr.WRITABLE, 2);
  strictEqual(pageTableEntryFrameMask, 0xffff_f000);
});

test("Virtual resolution markers are outside the stored PTE encoding", () => {
  const storedBits = Object.values(pageTableEntryAttr).reduce(
    (bits, attr) => bits | attr,
    pageTableEntryFrameMask
  );

  strictEqual(
    resolutionResultAttr.LATER_DENIAL &
      resolutionResultAttr.SCATTERED,
    0
  );
  strictEqual(resolutionResultAttr.LATER_DENIAL & storedBits, 0);
  strictEqual(resolutionResultAttr.SCATTERED & storedBits, 0);
});
