import type { OperandWidth } from "#x86/types.js";

export const LAZY_FLAGS_KIND = {
  NONE: 0,
  SUB: 1,
  ADD: 2,
  LOGIC_RESULT: 3
} as const;

export type LazyFlagsKind = (typeof LAZY_FLAGS_KIND)[keyof typeof LAZY_FLAGS_KIND];

export function lazyFlagsKindByte(kind: LazyFlagsKind, width: 0 | OperandWidth): number {
  return kind | (width << 2);
}
