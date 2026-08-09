import type { AnyValue } from "#compiler/function/values/type.js";
import type { FloatWidth } from "./float/types.js";
import type { FloatRef, IntegerRef } from "./expression.js";
import { floatSelect, type Float } from "./float/value.js";
import type { IntegerWidth } from "./integer/width.js";
import type { BitValue, Integer } from "./integer/types.js";
import { integerSelect } from "./integer/value.js";

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
export function select(condition: BitValue, whenTrue: AnyValue, whenFalse: AnyValue): AnyValue {
  switch (whenTrue.kind) {
    case "integer": {
      const trueValue = whenTrue as IntegerRef;

      return integerSelect(
        trueValue.width,
        condition,
        trueValue,
        whenFalse as IntegerRef
      ) as AnyValue;
    }
    case "float": {
      const trueValue = whenTrue as FloatRef;

      return floatSelect(trueValue.width, condition, trueValue, whenFalse as FloatRef) as AnyValue;
    }
  }
}
