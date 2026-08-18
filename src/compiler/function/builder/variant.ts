import { packVariant, type VariantValue } from "#compiler/layout/variant-codec.js";
import type { VariantLayout } from "#compiler/layout/variant.js";
import { layoutBitWidth } from "#compiler/layout/handles.js";
import { i64, type I32Value, type I64Value } from "../values.js";

export function buildVariant(layout: VariantLayout, value: VariantValue<I32Value>): I64Value {
  return packVariant(layout, value, {
    constant: i64,
    unsigned: (value, width) => value.truncate(layoutBitWidth(width)).unsigned.extend(64),
    shiftLeft: (value, bitCount) => value.shl(bitCount),
    or: (left, right) => left.or(right)
  });
}
