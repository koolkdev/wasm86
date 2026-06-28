import type { FlagValueOps } from "#x86/flag-values.js";
import type { ValueId, ValueTable } from "./values.js";

export function valueTableFlagOps(values: ValueTable): FlagValueOps<ValueId> {
  return {
    const32: (value) => values.internConst(value),
    project: (width, value) => values.projectTo(width, value),
    and: (a, b) => values.internBinary("and", a, b),
    sub: (a, b) => values.internBinary("sub", a, b),
    xor: (a, b) => values.internBinary("xor", a, b),
    shrU: (a, b) => values.internBinary("shr_u", a, b),
    popcnt: (value) => values.internUnary("popcnt", value),
    compare: (width, operator, a, b) => (
      values.internCompare(operator, values.projectTo(width, a), values.projectTo(width, b))
    ),
    select: (condition, whenTrue, whenFalse) => (
      values.internSelect(condition, whenTrue, whenFalse)
    )
  };
}
