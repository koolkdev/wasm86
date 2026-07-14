import type { FlagValueOps } from "#core/flags/values.js";
import type { ValueId } from "./values.js";
import type { ValueTable } from "./value-table.js";

export function valueTableFlagOps(values: ValueTable): FlagValueOps<ValueId> {
  return {
    const32: (value) => values.const(value),
    truncate: (width, value) => values.truncate(width, value),
    and: (a, b) => values.binary("and", a, b),
    sub: (a, b) => values.binary("sub", a, b),
    xor: (a, b) => values.binary("xor", a, b),
    shrU: (a, b) => values.binary("shr_u", a, b),
    popcnt: (value) => values.unary("popcnt", value),
    compare: (width, operator, a, b) => values.compare(width, operator, a, b),
    select: (condition, whenTrue, whenFalse) => (
      values.select(condition, whenTrue, whenFalse)
    )
  };
}
