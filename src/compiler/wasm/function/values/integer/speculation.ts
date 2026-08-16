import { wasmIntegerTypeWidth, type WasmIntegerWidth } from "#wasm/types.js";
import type { IntegerBinaryNode } from "../nodes.js";
import type { RequiredBits } from "./required-bits.js";

export function canSpeculateIntegerBinary(
  node: IntegerBinaryNode,
  leftBits: RequiredBits,
  leftConstant: bigint | undefined,
  rightConstant: bigint | undefined
): boolean {
  switch (node.operator) {
    case "div_s": {
      if (rightConstant === undefined || rightConstant === 0n) {
        return false;
      }
      if (rightConstant !== -1n) {
        return true;
      }
      const minimum = node.type === "i32" ? -0x8000_0000n : -0x8000_0000_0000_0000n;

      return leftConstant === undefined
        ? !mayContainSignedMinimum(leftBits, wasmIntegerTypeWidth(node.type))
        : leftConstant !== minimum;
    }
    case "div_u":
    case "rem_s":
    case "rem_u":
      return rightConstant !== undefined && rightConstant !== 0n;
    case "add":
    case "sub":
    case "mul":
    case "xor":
    case "or":
    case "and":
    case "shl":
    case "rotl":
    case "rotr":
    case "shr_s":
    case "shr_u":
      return true;
  }
}

function mayContainSignedMinimum(bits: RequiredBits, width: WasmIntegerWidth): boolean {
  return bits.unsigned === width && bits.signed === width;
}
