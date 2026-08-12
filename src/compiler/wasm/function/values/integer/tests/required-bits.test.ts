import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  binaryRequiredBits,
  constantRequiredBits,
  conversionRequiredBits,
  extendRequiredBits,
  joinRequiredBits,
  truncateRequiredBits,
  unaryRequiredBits,
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

test("binary operations derive conservative result requirements", () => {
  const byte = { unsigned: 8, signed: 9 };
  const word = { unsigned: 16, signed: 17 };

  deepStrictEqual(binaryRequiredBits("i32", "and", byte, word), {
    unsigned: 8,
    signed: 9
  });
  for (const operator of ["or", "xor"] as const) {
    deepStrictEqual(binaryRequiredBits("i32", operator, byte, word), {
      unsigned: 16,
      signed: 17
    });
  }
  deepStrictEqual(binaryRequiredBits("i32", "shl", byte, word, 34n), {
    unsigned: 10,
    signed: 11
  });
  deepStrictEqual(binaryRequiredBits("i32", "shl", byte, word), {
    unsigned: 32,
    signed: 32
  });
  deepStrictEqual(binaryRequiredBits("i64", "shr_u", word, byte, 8n), {
    unsigned: 8,
    signed: 9
  });
  deepStrictEqual(binaryRequiredBits("i64", "shr_u", word, byte), {
    unsigned: 16,
    signed: 17
  });
  deepStrictEqual(binaryRequiredBits("i32", "div_u", byte, word), {
    unsigned: 8,
    signed: 9
  });
  deepStrictEqual(binaryRequiredBits("i32", "rem_u", byte, word), {
    unsigned: 16,
    signed: 17
  });
  for (const operator of [
    "add",
    "sub",
    "mul",
    "div_s",
    "rem_s",
    "rotl",
    "rotr",
    "shr_s"
  ] as const) {
    deepStrictEqual(binaryRequiredBits("i32", operator, byte, word), {
      unsigned: 32,
      signed: 32
    });
  }
});

test("unary operations and conversions derive result requirements", () => {
  deepStrictEqual(unaryRequiredBits("i32", "extend8_s", { unsigned: 8, signed: 8 }), {
    unsigned: 32,
    signed: 8
  });
  deepStrictEqual(unaryRequiredBits("i32", "extend8_s", { unsigned: 7, signed: 8 }), {
    unsigned: 7,
    signed: 8
  });
  deepStrictEqual(unaryRequiredBits("i32", "extend16_s", { unsigned: 16, signed: 16 }), {
    unsigned: 32,
    signed: 16
  });
  for (const operator of ["clz", "ctz", "popcnt"] as const) {
    deepStrictEqual(unaryRequiredBits("i32", operator, { unsigned: 32, signed: 32 }), {
      unsigned: 6,
      signed: 7
    });
    deepStrictEqual(unaryRequiredBits("i64", operator, { unsigned: 64, signed: 64 }), {
      unsigned: 7,
      signed: 8
    });
  }
  deepStrictEqual(conversionRequiredBits("wrap_i64", { unsigned: 64, signed: 8 }), {
    unsigned: 32,
    signed: 8
  });
  deepStrictEqual(conversionRequiredBits("extend_i32_u", { unsigned: 8, signed: 9 }), {
    unsigned: 8,
    signed: 9
  });
  deepStrictEqual(conversionRequiredBits("extend_i32_s", { unsigned: 8, signed: 9 }), {
    unsigned: 8,
    signed: 9
  });
  deepStrictEqual(conversionRequiredBits("extend_i32_s", { unsigned: 32, signed: 8 }), {
    unsigned: 64,
    signed: 8
  });
});
