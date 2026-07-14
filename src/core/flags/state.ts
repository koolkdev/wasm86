import type { OperandWidth } from "#core/types.js";
import type { X86Flag } from "./definitions.js";

type FlagStateField<TByteLength extends 1 | 4> = Readonly<{
  offset: number;
  byteLength: TByteLength;
}>;

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

export const flagStateFields = {
  lazyKind: { offset: 40, byteLength: 1 },
  lazyA: { offset: 44, byteLength: 4 },
  lazyB: { offset: 48, byteLength: 4 },
  concrete: {
    CF: { offset: 52, byteLength: 1 },
    PF: { offset: 53, byteLength: 1 },
    AF: { offset: 54, byteLength: 1 },
    ZF: { offset: 55, byteLength: 1 },
    SF: { offset: 56, byteLength: 1 },
    OF: { offset: 57, byteLength: 1 },
    DF: { offset: 58, byteLength: 1 },
    TF: { offset: 59, byteLength: 1 },
    NT: { offset: 60, byteLength: 1 },
    AC: { offset: 61, byteLength: 1 },
    ID: { offset: 62, byteLength: 1 }
  }
} as const satisfies Readonly<{
  lazyKind: FlagStateField<1>;
  lazyA: FlagStateField<4>;
  lazyB: FlagStateField<4>;
  concrete: Readonly<Record<X86Flag, FlagStateField<1>>>;
}>;
