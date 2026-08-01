import { assert } from "#common/assert.js";
import type { IntegerWidth } from "#compiler/integer/width.js";
import { extendValue } from "../graph/extend.js";
import { truncateValue } from "../graph/truncate.js";
import type { ValueHandle } from "../handle.js";
import { operationValue } from "./value.js";
import type { Integer, ExtensionTargets, Signedness, TruncationTargets } from "./types.js";

type IntegerHandle = ValueHandle & Readonly<{ kind: "integer"; width: IntegerWidth }>;

export function extendInteger<
  Width extends IntegerWidth,
  TargetWidth extends ExtensionTargets<Width>
>(value: Integer<Width>, signedness: Signedness, width: TargetWidth): Integer<TargetWidth>;
export function extendInteger(
  value: IntegerHandle,
  signedness: Signedness,
  width: IntegerWidth
): ValueHandle;
export function extendInteger(
  value: IntegerHandle,
  signedness: Signedness,
  width: IntegerWidth
): ValueHandle {
  assert(width >= value.width, `cannot extend ${value.width} bits to ${width} bits`);

  if (width === value.width) {
    return value;
  }

  switch (width) {
    case 1:
      assert(false, "1-bit extension must preserve width");
    case 8:
      assert(false, "8-bit extension must preserve width");
    case 16:
      return operationValue(width, extendValue, {
        width,
        value,
        signed: signedness === "signed"
      });
    case 32:
      return operationValue(width, extendValue, {
        width,
        value,
        signed: signedness === "signed"
      });
    case 64:
      return operationValue(width, extendValue, {
        width,
        value,
        signed: signedness === "signed"
      });
  }
}

export function truncateInteger<
  Width extends IntegerWidth,
  TargetWidth extends TruncationTargets<Width>
>(value: Integer<Width>, width: TargetWidth): Integer<TargetWidth>;
export function truncateInteger(value: IntegerHandle, width: IntegerWidth): ValueHandle;
export function truncateInteger(value: IntegerHandle, width: IntegerWidth): ValueHandle {
  assert(width <= value.width, `cannot truncate ${value.width} bits to ${width} bits`);

  if (width === value.width) {
    return value;
  }

  switch (width) {
    case 1:
      return operationValue(width, truncateValue, { width, value });
    case 8:
      return operationValue(width, truncateValue, { width, value });
    case 16:
      return operationValue(width, truncateValue, { width, value });
    case 32:
      return operationValue(width, truncateValue, { width, value });
    case 64:
      assert(false, "64-bit truncation must preserve width");
  }
}
