import { assert } from "#common/assert.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { OperandWidth } from "#core/types.js";
import { x86StatusFlags, type X86StatusFlag } from "../definitions.js";
import { LAZY_FLAGS_KIND } from "./encoding.js";
import {
  addFlagSource,
  logicFlagSource,
  statusFlagValuesForSource,
  subFlagSource,
  type SimpleFlagSource
} from "./sources.js";

type StatusFlagBytes = Readonly<Record<X86StatusFlag, 0 | 1>>;

const lazyFlagWidths = [8, 16, 32] as const;

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

  const values = new ValueTable();
  const left = values.const(a);
  const right = values.const(b);
  const source = lazyFlagSource(values, kind, width, left, right);
  // Host reads use the compiler's normal flag graph with constant inputs, so
  // the ValueTable folds the architectural definition instead of duplicating it.
  const resolved = statusFlagValuesForSource(values, source, { undefinedAF: values.const(0) });
  const result = {} as Record<X86StatusFlag, 0 | 1>;

  for (const flag of x86StatusFlags) {
    const value = values.constValue(resolved[flag]);

    assert(value === 0 || value === 1, `lazy ${flag} did not fold to a flag byte`);
    result[flag] = value;
  }

  return result;
}

function lazyFlagSource(
  values: ValueTable,
  kind: number,
  width: OperandWidth,
  left: ValueId,
  right: ValueId
): SimpleFlagSource {
  switch (kind) {
    case LAZY_FLAGS_KIND.ADD:
      return addFlagSource({
        width,
        left,
        right,
        result: values.binary("add", left, right)
      });
    case LAZY_FLAGS_KIND.SUB:
      return subFlagSource({
        width,
        left,
        right,
        result: values.binary("sub", left, right)
      });
    case LAZY_FLAGS_KIND.LOGIC_RESULT:
      return logicFlagSource({ width, result: left });
    default:
      throw new RangeError(`invalid lazy-flags kind: ${kind}`);
  }
}
