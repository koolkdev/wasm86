import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { BitValue, Integer } from "./integer/types.js";
import { integerSelect } from "./integer/value.js";

export function select<Width extends IntegerWidth>(
  condition: BitValue,
  whenTrue: Integer<Width>,
  whenFalse: Integer<NoInfer<Width>>
): Integer<Width> {
  return integerSelect(whenTrue.width, condition, whenTrue, whenFalse);
}
