import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createVirtualStorageDefinition } from "#memory/virtual/storage.js";
import {
  pageTableEntries,
  pageTableEntryAttr,
  pageTableEntryFrameMask,
  virtualPageByteLength,
  virtualPageCount,
  virtualPageOffsetMask,
  virtualPageShift
} from "#memory/virtual/layout.js";

test("Virtual storage defines a complete u32 page table and its initial PTE encoding", () => {
  const storage = createVirtualStorageDefinition();
  const entries = storage.machineLayout.array(pageTableEntries);

  strictEqual(virtualPageShift, 12);
  strictEqual(virtualPageByteLength, 0x1000);
  strictEqual(virtualPageCount, 0x10_0000);
  strictEqual(virtualPageOffsetMask, 0x0fff);
  strictEqual(entries.count, 0x10_0000);
  strictEqual(entries.elementByteLength, 4);
  strictEqual(entries.elementAlignment, 4);
  strictEqual(pageTableEntryAttr.PRESENT, 1);
  strictEqual(pageTableEntryAttr.WRITABLE, 2);
  strictEqual(pageTableEntryFrameMask, 0xffff_f000);
  strictEqual(storage.machineImport.limits.minPages, 64);
});
