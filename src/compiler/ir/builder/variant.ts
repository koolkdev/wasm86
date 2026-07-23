import type { ValueTable } from "../values/table.js";
import type { ValueId } from "../values/types.js";
import {
  packVariant,
  type VariantValue
} from "#compiler/layout/variant-codec.js";
import type {
  VariantLayout
} from "#compiler/layout/variant.js";
import type { LayoutWidth } from "#compiler/layout/handles.js";

export function buildVariant(
  values: ValueTable,
  layout: VariantLayout,
  value: VariantValue<ValueId>
): ValueId {
  const packed = packVariant(layout, value, {
    constant: (value): VariantParts => ({ constant: value, dynamic: [] }),
    unsigned: (value, width) => {
      const constant = values.constValue(value);

      return constant === undefined
        ? {
          constant: 0n,
          dynamic: [values.extend64(bitWidth(width), value, false)]
        }
        : {
          constant: BigInt.asUintN(bitWidth(width), BigInt(constant)),
          dynamic: []
        };
    },
    shiftLeft: (parts, bitCount) => ({
      constant: parts.constant << BigInt(bitCount),
      dynamic: parts.dynamic.map((value) =>
        values.binary64("shl", value, values.const64(BigInt(bitCount))))
    }),
    or: (left, right) => ({
      constant: left.constant | right.constant,
      dynamic: [...left.dynamic, ...right.dynamic]
    })
  });

  let result: ValueId | undefined;

  for (const value of packed.dynamic) {
    result = result === undefined
      ? value
      : values.binary64("or", result, value);
  }

  const constant = values.const64(packed.constant);

  return result === undefined
    ? constant
    : values.binary64("or", result, constant);
}

type VariantParts = Readonly<{
  constant: bigint;
  dynamic: readonly ValueId[];
}>;

function bitWidth(width: LayoutWidth): 8 | 16 | 32 {
  switch (width) {
    case "u8":
      return 8;
    case "u16":
      return 16;
    case "u32":
      return 32;
  }
}
