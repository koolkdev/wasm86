import type { FlagValueOps } from "#core/flag-values.js";
import type { Values } from "#ir/values.js";
import type { Value } from "#x86/semantics/refs.js";

export function semanticFlagOps(v: Values): FlagValueOps<Value> {
  return {
    const32: (value) => v.const(value),
    truncate: (width, value) => v.truncate(width, value),
    and: (a, b) => v.binary("and", a, b),
    sub: (a, b) => v.binary("sub", a, b),
    xor: (a, b) => v.binary("xor", a, b),
    shrU: (a, b) => v.binary("shr_u", a, b),
    popcnt: (value) => v.unary("popcnt", value),
    compare: (width, operator, a, b) => v.compare(width, operator, a, b),
    select: (condition, whenTrue, whenFalse) => v.select(condition, whenTrue, whenFalse)
  };
}
