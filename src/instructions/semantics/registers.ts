import type { OperandWidth } from "#core/types.js";
import { reg, type RegRefForWidth } from "./refs.js";

const accumulatorByWidth: {
  readonly [Width in OperandWidth]: RegRefForWidth<Width>;
} = {
  8: reg("al"),
  16: reg("ax"),
  32: reg("eax")
};

export function accumulator<const Width extends OperandWidth>(width: Width): RegRefForWidth<Width> {
  return accumulatorByWidth[width];
}
