import { FieldRef } from "#compiler/layout/handles.js";
import { layoutStructure } from "#compiler/layout/structure.js";
import { x86Flags, type X86Flag } from "./definitions.js";

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

export type ConcreteFlagStateField =
  (typeof flagStateFields.concrete)[X86Flag];

export type LazyFlagStateField =
  | typeof flagStateFields.lazyKind
  | typeof flagStateFields.lazyA
  | typeof flagStateFields.lazyB;

export type FlagStateField = ConcreteFlagStateField | LazyFlagStateField;

const concreteFlagStateFields: ReadonlySet<FieldRef> = new Set(
  x86Flags.map((flag) => flagStateFields.concrete[flag])
);
const lazyFlagStateFields: ReadonlySet<FieldRef> = new Set([
  flagStateFields.lazyKind,
  flagStateFields.lazyA,
  flagStateFields.lazyB
]);

export function isConcreteFlagStateField(
  field: FieldRef
): field is ConcreteFlagStateField {
  return concreteFlagStateFields.has(field);
}

export function isLazyFlagStateField(field: FieldRef): field is LazyFlagStateField {
  return lazyFlagStateFields.has(field);
}

export const flagStateLayout = layoutStructure("core.flags", [
  flagStateFields.lazyKind,
  flagStateFields.lazyA,
  flagStateFields.lazyB,
  ...x86Flags.map((flag) => flagStateFields.concrete[flag])
]);
