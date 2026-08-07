import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  constantRequiredBits,
  extendRequiredBits,
  joinRequiredBits,
  truncateRequiredBits,
  zeroExtendedRequiredBits
} from "../required-bits.js";

test("required-bit upper bounds describe i32 and i64 values", () => {
  deepStrictEqual(zeroExtendedRequiredBits(32, 8), {
    unsigned: 8,
    signed: 9
  });
  deepStrictEqual(constantRequiredBits(32, -1), {
    unsigned: 32,
    signed: 1
  });
  deepStrictEqual(constantRequiredBits(64, -1n), {
    unsigned: 64,
    signed: 1
  });
  deepStrictEqual(extendRequiredBits(64, 32, { unsigned: 8, signed: 9 }, "zero"), {
    unsigned: 8,
    signed: 9
  });
  deepStrictEqual(extendRequiredBits(64, 32, { unsigned: 32, signed: 8 }, "sign"), {
    unsigned: 64,
    signed: 8
  });
  deepStrictEqual(truncateRequiredBits(32, { unsigned: 64, signed: 8 }), {
    unsigned: 32,
    signed: 8
  });
});

test("joining required-bit facts covers every input", () => {
  deepStrictEqual(
    joinRequiredBits(64, [
      { unsigned: 8, signed: 9 },
      { unsigned: 64, signed: 16 }
    ]),
    { unsigned: 64, signed: 16 }
  );
  deepStrictEqual(joinRequiredBits(64, []), {
    unsigned: 64,
    signed: 64
  });
});
