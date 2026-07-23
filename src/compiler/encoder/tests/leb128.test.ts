import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  encodeI32Leb128,
  encodeI64Leb128,
  encodeU32Leb128
} from "#compiler/encoder/leb128.js";

test("u32 LEB128 uses the canonical boundary encodings", () => {
  for (const [value, expected] of [
    [0, [0x00]],
    [0x7f, [0x7f]],
    [0x80, [0x80, 0x01]],
    [0xffff_ffff, [0xff, 0xff, 0xff, 0xff, 0x0f]]
  ] as const) {
    deepStrictEqual(encodeU32Leb128(value), expected);
  }
});

test("signed LEB128 preserves sign at byte boundaries", () => {
  for (const [value, expected] of [
    [-65, [0xbf, 0x7f]],
    [-64, [0x40]],
    [63, [0x3f]],
    [64, [0xc0, 0x00]]
  ] as const) {
    deepStrictEqual(encodeI32Leb128(value), expected);
    deepStrictEqual(encodeI64Leb128(BigInt(value)), expected);
  }
});

test("LEB128 rejects values outside its declared integer type", () => {
  throws(() => encodeU32Leb128(-1), RangeError);
  throws(() => encodeI32Leb128(0x8000_0000), RangeError);
  throws(() => encodeI64Leb128(1n << 63n), RangeError);
});
