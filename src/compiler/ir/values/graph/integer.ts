import type { IntegerWidth } from "#compiler/integer/width.js";

export function normalizeInteger(width: IntegerWidth, value: number | bigint): bigint {
  return BigInt.asUintN(width, BigInt(value));
}

export function signedInteger(width: IntegerWidth, value: bigint): bigint {
  return BigInt.asIntN(width, value);
}
