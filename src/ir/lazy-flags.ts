import type { OperandWidth } from "#core/types.js";

export const LAZY_FLAGS_KIND = {
  NONE: 0,
  SUB: 1,
  ADD: 2,
  LOGIC_RESULT: 3
} as const;

export type LazyFlagsKind = (typeof LAZY_FLAGS_KIND)[keyof typeof LAZY_FLAGS_KIND];

export function lazyFlagsKindByte(kind: LazyFlagsKind, width: 0 | OperandWidth): number {
  return kind | (lazyFlagsWidthCode(width) << 2);
}

function lazyFlagsWidthCode(width: 0 | OperandWidth): 0 | 1 | 2 {
  switch (width) {
    case 0:
    case 8:
      return 0;
    case 16:
      return 1;
    case 32:
      return 2;
  }
}
