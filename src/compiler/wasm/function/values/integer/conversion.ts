import {
  extendRequiredBits,
  truncateRequiredBits,
  type RequiredBits,
  type RequiredBitsQuery
} from "./required-bits.js";
import type { ConversionNode } from "../nodes.js";

export function conversionRequiredBits(
  node: ConversionNode,
  query: RequiredBitsQuery
): RequiredBits {
  const source = query.requiredBits(node.inputs[0]);

  switch (node.operator) {
    case "wrap_i64":
      return truncateRequiredBits(32, source);
    case "extend_i32_u":
      return extendRequiredBits(64, 32, source, "zero");
    case "extend_i32_s":
      return extendRequiredBits(64, 32, source, "sign");
  }
}
