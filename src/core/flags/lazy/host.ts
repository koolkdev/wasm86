import { assert } from "#common/assert.js";
import { foldNarrowValues } from "#compiler/function/values/fold.js";
import { integer, type Integer } from "#compiler/function/values.js";
import type { OperandWidth } from "#core/types.js";
import type { StatusFlagValues } from "../values.js";
import { x86StatusFlags, type X86StatusFlag } from "../definitions.js";
import { LAZY_FLAGS_KIND, lazyFlagWidths } from "./encoding.js";
import {
  addFlagSource,
  logicFlagSource,
  statusFlagValuesForSource,
  subFlagSource
} from "./sources.js";

type StatusFlagBytes = Readonly<Record<X86StatusFlag, 0 | 1>>;

export function resolveLazyStatusFlagBytes(
  kindByte: number,
  a: number,
  b: number
): StatusFlagBytes {
  const kind = kindByte & 0b11;
  const width = lazyFlagWidths[kindByte >>> 2];

  if (width === undefined || kind === LAZY_FLAGS_KIND.NONE) {
    throw new RangeError(`invalid lazy-flags kind byte: ${kindByte}`);
  }

  // Host resolution uses the same flag expressions as generated code, with
  // constant inputs.
  const resolved = lazyStatusFlagValuesAtWidth(kind, integer(width, a), integer(width, b));
  const folded = foldNarrowValues(x86StatusFlags.map((flag) => resolved[flag]));
  const result = {} as Record<X86StatusFlag, 0 | 1>;

  for (const [index, flag] of x86StatusFlags.entries()) {
    const value = folded[index];

    assert(value === 0 || value === 1, `lazy ${flag} did not fold to a flag byte`);
    result[flag] = value;
  }

  return result;
}

function lazyStatusFlagValuesAtWidth<Width extends OperandWidth>(
  kind: number,
  left: Integer<Width>,
  right: Integer<Width>
): StatusFlagValues {
  switch (kind) {
    case LAZY_FLAGS_KIND.ADD: {
      const source = addFlagSource({
        left,
        right,
        result: left.add(right)
      });

      return statusFlagValuesForSource(source, { undefinedAF: integer(1, 0) });
    }
    case LAZY_FLAGS_KIND.SUB: {
      const source = subFlagSource({
        left,
        right,
        result: left.sub(right)
      });

      return statusFlagValuesForSource(source, { undefinedAF: integer(1, 0) });
    }
    case LAZY_FLAGS_KIND.LOGIC_RESULT:
      return statusFlagValuesForSource(logicFlagSource({ result: left }), {
        undefinedAF: integer(1, 0)
      });
    default:
      throw new RangeError(`invalid lazy-flags kind: ${kind}`);
  }
}
