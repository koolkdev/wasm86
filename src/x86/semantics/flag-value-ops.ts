import type { FlagValueOps } from "#x86/flag-values.js";
import type { SemanticsBuilder } from "#x86/semantics/builder.js";
import type { Value } from "#x86/semantics/refs.js";

export function semanticFlagOps(s: SemanticsBuilder): FlagValueOps<Value> {
  return {
    const32: (value) => s.const32(value),
    project: (width, value) => s.project(width, value),
    and: (a, b) => s.binary("and", a, b),
    sub: (a, b) => s.binary("sub", a, b),
    xor: (a, b) => s.binary("xor", a, b),
    shrU: (a, b) => s.binary("shr_u", a, b),
    popcnt: (value) => s.unary("popcnt", value),
    compare: (width, operator, a, b) => s.compare(width, operator, a, b),
    select: (condition, whenTrue, whenFalse) => s.select(condition, whenTrue, whenFalse)
  };
}
