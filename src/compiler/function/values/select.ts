import { assert } from "#common/assert.js";
import type { FloatWidth } from "#compiler/function/values/float/type.js";
import { floatSelect, type Float } from "#compiler/function/values/float/value.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { BitValue, Integer } from "./integer/types.js";
import { integerSelect } from "./integer/value.js";
import type { ValueRef } from "./reference.js";
import type { AnyValue } from "./type.js";

export function select<Width extends IntegerWidth>(
  condition: BitValue,
  whenTrue: Integer<Width>,
  whenFalse: Integer<NoInfer<Width>>
): Integer<Width>;
export function select<Width extends FloatWidth>(
  condition: BitValue,
  whenTrue: Float<Width>,
  whenFalse: Float<NoInfer<Width>>
): Float<Width>;
export function select(condition: BitValue, whenTrue: AnyValue, whenFalse: AnyValue): ValueRef {
  switch (whenTrue.kind) {
    case "integer": {
      if (whenFalse.kind === "integer" && whenFalse.width === whenTrue.width) {
        return integerSelect(whenTrue.width, condition, whenTrue, whenFalse);
      }
      break;
    }
    case "float": {
      if (whenFalse.kind === "float" && whenFalse.width === whenTrue.width) {
        return floatSelect(whenTrue.width, condition, whenTrue, whenFalse);
      }
      break;
    }
  }
  assert(false, "select alternatives must have one value type");
}
