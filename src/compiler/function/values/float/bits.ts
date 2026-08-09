import type { FloatBits, FloatWidth } from "./types.js";

export function floatBits<Width extends FloatWidth>(width: Width, value: number): FloatBits<Width>;
export function floatBits(width: FloatWidth, value: number): number | bigint {
  if (width === 32) {
    scratch.setFloat32(0, value);
    return scratch.getUint32(0);
  }
  scratch.setFloat64(0, value);
  return scratch.getBigUint64(0);
}

export function floatFromBits<Width extends FloatWidth>(
  width: Width,
  bits: FloatBits<Width>
): number;
export function floatFromBits(width: FloatWidth, bits: number | bigint): number {
  if (width === 32) {
    scratch.setUint32(0, Number(bits));
    return scratch.getFloat32(0);
  }
  scratch.setBigUint64(0, BigInt(bits));
  return scratch.getFloat64(0);
}

const scratch = new DataView(new ArrayBuffer(8));
