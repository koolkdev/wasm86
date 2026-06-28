import type { FlagValueOps } from "#x86/flag-values.js";
import type { ValueId, ValueTable } from "./values.js";

export function valueTableFlagOps(values: ValueTable): FlagValueOps<ValueId> {
  return {
    const32: (value) => values.const(value),
    project: (width, value) => values.project(width, value),
    and: (a, b) => values.binary("and", a, b),
    sub: (a, b) => values.binary("sub", a, b),
    xor: (a, b) => values.binary("xor", a, b),
    shrU: (a, b) => values.binary("shr_u", a, b),
    popcnt: (value) => values.unary("popcnt", value),
    compare: (width, operator, a, b) => (
      values.compare(operator, values.project(width, a), values.project(width, b))
    ),
    select: (condition, whenTrue, whenFalse) => (
      values.select(condition, whenTrue, whenFalse)
    )
  };
}
