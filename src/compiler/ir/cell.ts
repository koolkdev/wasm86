import type { ValueType } from "#compiler/ir/values/types.js";

// Compiler-private mutable cell storage: distinct by object identity, scoped
// structurally by its seed site — the seed write is the declaration, and an
// access is legal exactly where that seed dominates it. No numbering, no
// side tables; validation derives scope from the region tree alone.
export class CellRef<Type extends ValueType = ValueType> {
  readonly kind = "cell";

  constructor(readonly type: Type) {}
}
