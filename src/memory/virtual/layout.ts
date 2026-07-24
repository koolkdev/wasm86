import { ArrayRef } from "#compiler/layout/handles.js";
import { layoutStructure } from "#compiler/layout/structure.js";

export const virtualPageShift = 12;
export const virtualPageByteLength = 0x1000;
export const virtualPageCount = 0x10_0000;
export const virtualPageOffsetMask = 0x0fff;

export const pageTableEntryAttr = {
  PRESENT: 1 << 0,
  WRITABLE: 1 << 1
} as const;

export const pageTableEntryFrameMask = 0xffff_f000;

export const pageTableEntryLayout = {
  byteLength: 4,
  alignment: 4
} as const;

export const pageTableEntries = new ArrayRef(
  "memory.virtual.page-table",
  {
    count: virtualPageCount,
    element: pageTableEntryLayout
  }
);

export const virtualStorageLayout = layoutStructure(
  "memory.virtual",
  [pageTableEntries]
);
