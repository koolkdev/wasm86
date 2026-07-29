import type { ValueWidth } from "#compiler/integer/width.js";

export function normalizeInteger(width: ValueWidth, value: number | bigint): bigint {
  return BigInt.asUintN(width, BigInt(value));
}

export function signedInteger(width: ValueWidth, value: bigint): bigint {
  return BigInt.asIntN(width, value);
}
