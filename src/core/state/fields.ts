import { assert } from "#common/assert.js";
import { reg32, segmentRegisters } from "#core/types.js";

type CoreStateField<TByteLength extends 1 | 2 | 4> = Readonly<{
  offset: number;
  byteLength: TByteLength;
}>;

export const gprFields = [
  { offset: 0, byteLength: 4 },
  { offset: 4, byteLength: 4 },
  { offset: 8, byteLength: 4 },
  { offset: 12, byteLength: 4 },
  { offset: 16, byteLength: 4 },
  { offset: 20, byteLength: 4 },
  { offset: 24, byteLength: 4 },
  { offset: 28, byteLength: 4 }
] as const satisfies readonly CoreStateField<4>[];

export const eipField = {
  offset: 32,
  byteLength: 4
} as const satisfies CoreStateField<4>;

export type SegmentStateField = "selector" | "base" | "limit" | "access";

export const segmentFields = {
  selectors: [
    { offset: 64, byteLength: 2 },
    { offset: 66, byteLength: 2 },
    { offset: 68, byteLength: 2 },
    { offset: 70, byteLength: 2 },
    { offset: 72, byteLength: 2 },
    { offset: 74, byteLength: 2 }
  ],
  bases: [
    { offset: 76, byteLength: 4 },
    { offset: 80, byteLength: 4 },
    { offset: 84, byteLength: 4 },
    { offset: 88, byteLength: 4 },
    { offset: 92, byteLength: 4 },
    { offset: 96, byteLength: 4 }
  ],
  limits: [
    { offset: 100, byteLength: 4 },
    { offset: 104, byteLength: 4 },
    { offset: 108, byteLength: 4 },
    { offset: 112, byteLength: 4 },
    { offset: 116, byteLength: 4 },
    { offset: 120, byteLength: 4 }
  ],
  access: [
    { offset: 124, byteLength: 4 },
    { offset: 128, byteLength: 4 },
    { offset: 132, byteLength: 4 },
    { offset: 136, byteLength: 4 },
    { offset: 140, byteLength: 4 },
    { offset: 144, byteLength: 4 }
  ]
} as const satisfies Readonly<{
  selectors: readonly CoreStateField<2>[];
  bases: readonly CoreStateField<4>[];
  limits: readonly CoreStateField<4>[];
  access: readonly CoreStateField<4>[];
}>;

assert(gprFields.length === reg32.length, "core state must define every GPR");

for (const [index, field] of gprFields.entries()) {
  assert(
    field.offset === gprFields[0].offset + index * 4,
    "core state GPR words must be contiguous in ModRM register order"
  );
}

assert(
  segmentFields.selectors.length === segmentRegisters.length &&
  segmentFields.bases.length === segmentRegisters.length &&
  segmentFields.limits.length === segmentRegisters.length &&
  segmentFields.access.length === segmentRegisters.length,
  "core state must define every segment field"
);

for (const [index, field] of segmentFields.selectors.entries()) {
  assert(
    field.offset === segmentFields.selectors[0].offset + index * 2,
    "core state segment selectors must be contiguous in segment register order"
  );
}

for (const [index, field] of segmentFields.bases.entries()) {
  assert(
    field.offset === segmentFields.bases[0].offset + index * 4,
    "core state segment bases must be contiguous in segment register order"
  );
}

for (const [index, field] of segmentFields.limits.entries()) {
  assert(
    field.offset === segmentFields.limits[0].offset + index * 4,
    "core state segment limits must be contiguous in segment register order"
  );
}

for (const [index, field] of segmentFields.access.entries()) {
  assert(
    field.offset === segmentFields.access[0].offset + index * 4,
    "core state segment access words must be contiguous in segment register order"
  );
}
