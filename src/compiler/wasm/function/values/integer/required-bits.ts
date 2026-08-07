import { bitLength, type IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { WasmIntegerWidth } from "#wasm/types.js";
import type { WasmValueId } from "../nodes.js";

// Upper bounds on the number of bits needed to represent any possible value
// as unsigned or two's-complement signed in its current Wasm integer type.
export type RequiredBits = Readonly<{
  unsigned: number;
  signed: number;
}>;

export type RequiredBitsQuery = Readonly<{
  requiredBits(id: WasmValueId): RequiredBits;
}>;

export function unknownRequiredBits(width: WasmIntegerWidth): RequiredBits {
  return { unsigned: width, signed: width };
}

export function joinRequiredBits(
  width: WasmIntegerWidth,
  values: Iterable<RequiredBits>
): RequiredBits {
  let joined: RequiredBits | undefined;

  for (const value of values) {
    joined =
      joined === undefined
        ? value
        : {
            unsigned: Math.max(joined.unsigned, value.unsigned),
            signed: Math.max(joined.signed, value.signed)
          };
  }
  return joined ?? unknownRequiredBits(width);
}

export function zeroExtendedRequiredBits(width: WasmIntegerWidth, bits: number): RequiredBits {
  return clampRequiredBits(width, bits, width);
}

function signExtendedRequiredBits(width: WasmIntegerWidth, bits: number): RequiredBits {
  return clampRequiredBits(width, width, bits);
}

export function clampRequiredBits(
  width: WasmIntegerWidth,
  unsigned: number,
  signed: number
): RequiredBits {
  const clampedUnsigned = Math.min(width, Math.max(1, unsigned));

  return {
    unsigned: clampedUnsigned,
    signed: Math.min(width, Math.max(1, signed), clampedUnsigned + 1)
  };
}

export function constantRequiredBits(
  width: WasmIntegerWidth,
  value: number | bigint
): RequiredBits {
  const normalized = BigInt.asUintN(width, BigInt(value));
  const signedValue = BigInt.asIntN(width, normalized);

  return {
    unsigned: Math.max(1, bitLength(normalized)),
    signed: Math.min(width, bitLength(signedValue < 0n ? ~signedValue : signedValue) + 1)
  };
}

export function extendRequiredBits(
  targetWidth: WasmIntegerWidth,
  sourceWidth: IntegerWidth,
  source: RequiredBits,
  extension: "zero" | "sign"
): RequiredBits {
  if (extension === "zero") {
    return zeroExtendedRequiredBits(targetWidth, Math.min(sourceWidth, source.unsigned));
  }
  if (source.unsigned < sourceWidth) {
    return clampRequiredBits(targetWidth, source.unsigned, source.signed);
  }
  return signExtendedRequiredBits(targetWidth, Math.min(sourceWidth, source.signed));
}

export function truncateRequiredBits(
  targetWidth: WasmIntegerWidth,
  source: RequiredBits
): RequiredBits {
  return clampRequiredBits(targetWidth, source.unsigned, source.signed);
}

export function mayContainSignedMinimum(bits: RequiredBits, width: WasmIntegerWidth): boolean {
  return bits.unsigned === width && bits.signed === width;
}
