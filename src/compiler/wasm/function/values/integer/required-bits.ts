import { bitLength, type IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { BinaryOperator } from "#compiler/function/values/integer/operators.js";
import { wasmIntegerTypeWidth, type WasmIntegerType, type WasmIntegerWidth } from "#wasm/types.js";
import type { ConversionOperator, UnaryOperator } from "../nodes.js";

// Upper bounds on the number of bits needed to represent any possible value
// as unsigned or two's-complement signed in its current Wasm integer type.
export type RequiredBits = Readonly<{
  unsigned: number;
  signed: number;
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

function clampRequiredBits(
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

export function binaryRequiredBits(
  type: WasmIntegerType,
  operator: BinaryOperator,
  left: RequiredBits,
  right: RequiredBits,
  rightConstant?: bigint
): RequiredBits {
  const width = wasmIntegerTypeWidth(type);

  switch (operator) {
    case "xor":
    case "or":
      return clampRequiredBits(
        width,
        Math.max(left.unsigned, right.unsigned),
        Math.max(left.signed, right.signed)
      );
    case "and":
      return clampRequiredBits(
        width,
        Math.min(left.unsigned, right.unsigned),
        Math.max(left.signed, right.signed)
      );
    case "shl": {
      const shift = effectiveWasmShift(width, rightConstant);

      return shift === undefined
        ? unknownRequiredBits(width)
        : zeroExtendedRequiredBits(width, left.unsigned + shift);
    }
    case "shr_u": {
      const shift = effectiveWasmShift(width, rightConstant);

      return shift === undefined
        ? clampRequiredBits(width, left.unsigned, width)
        : zeroExtendedRequiredBits(width, Math.max(1, left.unsigned - shift));
    }
    case "div_u":
      return zeroExtendedRequiredBits(width, left.unsigned);
    case "rem_u":
      return zeroExtendedRequiredBits(width, right.unsigned);
    case "add":
    case "sub":
    case "mul":
    case "div_s":
    case "rem_s":
    case "rotl":
    case "rotr":
    case "shr_s":
      return unknownRequiredBits(width);
  }
}

export function unaryRequiredBits(
  type: WasmIntegerType,
  operator: UnaryOperator,
  source: RequiredBits
): RequiredBits {
  if (operator === "extend8_s" || operator === "extend16_s") {
    return extendRequiredBits(32, operator === "extend8_s" ? 8 : 16, source, "sign");
  }
  const width = wasmIntegerTypeWidth(type);
  const countBits = Math.max(1, 32 - Math.clz32(width));

  return zeroExtendedRequiredBits(width, countBits);
}

export function conversionRequiredBits(
  operator: ConversionOperator,
  source: RequiredBits
): RequiredBits {
  switch (operator) {
    case "wrap_i64":
      return truncateRequiredBits(32, source);
    case "extend_i32_u":
      return extendRequiredBits(64, 32, source, "zero");
    case "extend_i32_s":
      return extendRequiredBits(64, 32, source, "sign");
  }
}

function effectiveWasmShift(
  width: WasmIntegerWidth,
  constant: bigint | undefined
): number | undefined {
  return constant === undefined ? undefined : Number(constant & BigInt(width - 1));
}
