import { bitField, FieldRef, type AnyFieldRef } from "#compiler/layout/handles.js";
import { layoutStructure } from "#compiler/layout/structure.js";
import { x86Flags, type X86Flag } from "./definitions.js";

const concreteFlagFields = {
  CF: bitField("core.flags.CF"),
  PF: bitField("core.flags.PF"),
  AF: bitField("core.flags.AF"),
  ZF: bitField("core.flags.ZF"),
  SF: bitField("core.flags.SF"),
  OF: bitField("core.flags.OF"),
  DF: bitField("core.flags.DF"),
  TF: bitField("core.flags.TF"),
  NT: bitField("core.flags.NT"),
  AC: bitField("core.flags.AC"),
  ID: bitField("core.flags.ID")
} as const satisfies Readonly<Record<X86Flag, FieldRef<"u8", 1>>>;

export const flagStateFields = {
  lazyKind: new FieldRef("core.flags.lazy-flag.kind", "u8"),
  lazyA: new FieldRef("core.flags.lazy-flag.a", "u32"),
  lazyB: new FieldRef("core.flags.lazy-flag.b", "u32"),
  concrete: concreteFlagFields
} as const;

export type ConcreteFlagStateField = (typeof flagStateFields.concrete)[X86Flag];

export type LazyFlagStateField =
  typeof flagStateFields.lazyKind | typeof flagStateFields.lazyA | typeof flagStateFields.lazyB;

export type FlagStateField = ConcreteFlagStateField | LazyFlagStateField;

const concreteFlagStateFields: ReadonlySet<AnyFieldRef> = new Set(
  x86Flags.map((flag) => flagStateFields.concrete[flag])
);
const lazyFlagStateFields: ReadonlySet<AnyFieldRef> = new Set([
  flagStateFields.lazyKind,
  flagStateFields.lazyA,
  flagStateFields.lazyB
]);

export function isConcreteFlagStateField(field: AnyFieldRef): field is ConcreteFlagStateField {
  return concreteFlagStateFields.has(field);
}

export function isLazyFlagStateField(field: AnyFieldRef): field is LazyFlagStateField {
  return lazyFlagStateFields.has(field);
}

export const flagStateLayout = layoutStructure("core.flags", [
  flagStateFields.lazyKind,
  flagStateFields.lazyA,
  flagStateFields.lazyB,
  ...x86Flags.map((flag) => flagStateFields.concrete[flag])
]);
