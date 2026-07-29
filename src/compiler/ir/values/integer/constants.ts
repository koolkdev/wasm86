import { assert } from "#common/assert.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import { constantValue } from "../graph/leaves.js";
import { operationValue } from "./value.js";
import type { AnyInteger, Integer, IntegerLiteral, I32Value, I64Value } from "./types.js";

export function integer<Width extends IntegerWidth>(
  width: Width,
  value: IntegerLiteral<Width>
): Integer<Width>;
export function integer(width: IntegerWidth, value: number | bigint): AnyInteger {
  switch (width) {
    case 1:
      assert(typeof value === "number", "1-bit constants use number values");
      return operationValue(1, constantValue, { width: 1, value });
    case 8:
      assert(typeof value === "number", "8-bit constants use number values");
      return operationValue(8, constantValue, { width: 8, value });
    case 16:
      assert(typeof value === "number", "16-bit constants use number values");
      return operationValue(16, constantValue, { width: 16, value });
    case 32:
      assert(typeof value === "number", "32-bit constants use number values");
      return operationValue(32, constantValue, { width: 32, value });
    case 64:
      assert(typeof value === "bigint", "64-bit constants use bigint values");
      return operationValue(64, constantValue, { width: 64, value });
  }
}

export function i32(value: number): I32Value {
  return integer(32, value);
}

export function i64(value: bigint): I64Value {
  return integer(64, value);
}

// Signed and unsigned literal spellings produce the same neutral bits.
export function i8(value: number): Integer<8> {
  return integer(8, value);
}

export function u8(value: number): Integer<8> {
  return integer(8, value);
}

export function i16(value: number): Integer<16> {
  return integer(16, value);
}

export function u16(value: number): Integer<16> {
  return integer(16, value);
}
