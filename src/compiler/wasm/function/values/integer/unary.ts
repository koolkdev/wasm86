import { wasmIntegerTypeWidth, type WasmIntegerWidth } from "#wasm/types.js";
import {
  extendRequiredBits,
  zeroExtendedRequiredBits,
  type RequiredBits,
  type RequiredBitsQuery
} from "./required-bits.js";
import type { UnaryNode } from "../nodes.js";

export function unaryRequiredBits(node: UnaryNode, query: RequiredBitsQuery): RequiredBits {
  if (node.operator === "extend8_s" || node.operator === "extend16_s") {
    const sourceWidth = node.operator === "extend8_s" ? 8 : 16;

    return extendRequiredBits(32, sourceWidth, query.requiredBits(node.inputs[0]), "sign");
  }
  const width = wasmIntegerTypeWidth(node.type);

  return zeroExtendedRequiredBits(width, countResultBits(width));
}

function countResultBits(width: WasmIntegerWidth): number {
  return Math.max(1, 32 - Math.clz32(width));
}
