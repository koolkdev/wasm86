import type { WidthBounds } from "./types.js";

export const unboundedWidthBounds: WidthBounds = { unsignedBits: 32, signedBits: 32 };

export function joinWidthBounds(bounds: Iterable<WidthBounds>): WidthBounds {
  let joined: WidthBounds | undefined;

  for (const bound of bounds) {
    joined = joined === undefined
      ? bound
      : {
          unsignedBits: Math.max(joined.unsignedBits, bound.unsignedBits),
          signedBits: Math.max(joined.signedBits, bound.signedBits)
        };
  }

  return joined ?? unboundedWidthBounds;
}

export function fitsUnsigned(bits: number): WidthBounds {
  return clampedBounds(bits, 32);
}

export function signExtended(bits: number): WidthBounds {
  return clampedBounds(32, bits);
}

export function clampedBounds(unsignedBits: number, signedBits: number): WidthBounds {
  return {
    unsignedBits,
    // Fitting unsigned in w implies sign extension from w + 1.
    signedBits: Math.min(signedBits, unsignedBits + 1, 32)
  };
}
