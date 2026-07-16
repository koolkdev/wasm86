import type { SiteId } from "#compiler/analysis/model.js";
import type { CellRef } from "#compiler/refs/cell.js";
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
  // Cells own dedicated physical plan locals; they never share storage with
  // value temporaries or expose numbering outside placement.
  cellLocals: ReadonlyMap<CellRef, number>;
}>;
