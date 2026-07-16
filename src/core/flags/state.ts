import { FieldRef } from "#compiler/layout/handles.js";
import { layoutStructure } from "#compiler/layout/structure.js";
import type { OperandWidth } from "#core/types.js";
import { x86Flags, type X86Flag } from "./definitions.js";

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

const concreteFlagFields = {
  CF: new FieldRef("core.flags.CF", "u8"),
  PF: new FieldRef("core.flags.PF", "u8"),
  AF: new FieldRef("core.flags.AF", "u8"),
  ZF: new FieldRef("core.flags.ZF", "u8"),
  SF: new FieldRef("core.flags.SF", "u8"),
  OF: new FieldRef("core.flags.OF", "u8"),
  DF: new FieldRef("core.flags.DF", "u8"),
  TF: new FieldRef("core.flags.TF", "u8"),
  NT: new FieldRef("core.flags.NT", "u8"),
  AC: new FieldRef("core.flags.AC", "u8"),
  ID: new FieldRef("core.flags.ID", "u8")
} as const satisfies Readonly<Record<X86Flag, FieldRef<"u8">>>;

export const flagStateFields = {
  lazyKind: new FieldRef("core.flags.lazy-flag.kind", "u8"),
  lazyA: new FieldRef("core.flags.lazy-flag.a", "u32"),
  lazyB: new FieldRef("core.flags.lazy-flag.b", "u32"),
  concrete: concreteFlagFields
} as const;

export const flagState = layoutStructure("core.flags", [
  flagStateFields.lazyKind,
  flagStateFields.lazyA,
  flagStateFields.lazyB,
  ...x86Flags.map((flag) => flagStateFields.concrete[flag])
]);
