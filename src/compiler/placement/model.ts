import type { SiteId } from "#compiler/analysis/model.js";
import type { ValueType } from "#compiler/ir/values/types.js";

export type ValuePlacement =
  | Readonly<{
      kind: "atUse";
      anchor: SiteId;
      local: number | undefined;
    }>
  | Readonly<{
      kind: "capture";
      anchor: SiteId;
      local: number;
    }>
  | Readonly<{
      kind: "control";
      anchor: SiteId;
      local: number;
    }>
  | Readonly<{
      kind: "loopInput";
      local: number;
    }>;

export type PlacementPlan = Readonly<{
  // ValueId-indexed. Re-emittable and dead values have no placement.
  values: readonly (ValuePlacement | undefined)[];
  // Physical plan local -> value type.
  localTypes: readonly ValueType[];
  // Semantic variable index -> physical plan local.
  variableLocals: readonly (number | undefined)[];
}>;
