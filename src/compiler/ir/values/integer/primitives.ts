import { assert } from "#common/assert.js";
import { unreachableValue } from "../graph/leaves.js";
import { selectValue } from "../graph/select.js";
import { zeroTestValue } from "../graph/zero-test.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import { operationValue } from "./value.js";
import type { AnyInteger, Integer, BitValue, I32Value } from "./types.js";

export function unreachable(): I32Value;
export function unreachable<Width extends IntegerWidth>(width: Width): Integer<Width>;
export function unreachable(width: IntegerWidth = 32): AnyInteger {
  switch (width) {
    case 1:
      return operationValue(1, unreachableValue, { width });
    case 8:
      return operationValue(8, unreachableValue, { width });
    case 16:
      return operationValue(16, unreachableValue, { width });
    case 32:
      return operationValue(32, unreachableValue, { width });
    case 64:
      return operationValue(64, unreachableValue, { width });
  }
}

export function select<Width extends IntegerWidth>(
  condition: BitValue,
  whenTrue: Integer<Width>,
  whenFalse: Integer<NoInfer<Width>>
): Integer<Width> {
  assert(
    whenFalse.width === whenTrue.width,
    `${whenFalse.width}-bit select arm does not match ${whenTrue.width}-bit result`
  );

  return operationValue(whenTrue.width, selectValue, {
    condition,
    whenTrue,
    whenFalse
  });
}

export function nonzero(value: AnyInteger): BitValue {
  return operationValue(1, zeroTestValue, { operator: "nonzero", value });
}
