import { i32 } from "#x86/state/cpu-state.js";
import type { ExprRef, JitInputSource } from "./types.js";

export function exprsEqual(left: ExprRef, right: ExprRef): boolean {
  if (left === right) {
    return true;
  }

  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "const":
      return i32(left.value) === i32((right as typeof left).value);
    case "input":
      return inputSourcesEqual(left.source, (right as typeof left).source);
    case "binary":
      return left.op === (right as typeof left).op &&
        exprsEqual(left.left, (right as typeof left).left) &&
        exprsEqual(left.right, (right as typeof left).right);
    case "unary":
      return left.op === (right as typeof left).op && exprsEqual(left.value, (right as typeof left).value);
    case "select":
      return exprsEqual(left.condition, (right as typeof left).condition) &&
        exprsEqual(left.whenTrue, (right as typeof left).whenTrue) &&
        exprsEqual(left.whenFalse, (right as typeof left).whenFalse);
    case "project":
      return left.width === (right as typeof left).width && exprsEqual(left.value, (right as typeof left).value);
    case "bits":
      return left.offset === (right as typeof left).offset &&
        left.width === (right as typeof left).width &&
        exprsEqual(left.value, (right as typeof left).value);
    case "insertBits":
      return left.offset === (right as typeof left).offset &&
        left.width === (right as typeof left).width &&
        exprsEqual(left.base, (right as typeof left).base) &&
        exprsEqual(left.value, (right as typeof left).value);
    case "testBit":
      return left.bit === (right as typeof left).bit && exprsEqual(left.value, (right as typeof left).value);
    case "compare":
      return left.op === (right as typeof left).op &&
        exprsEqual(left.left, (right as typeof left).left) &&
        exprsEqual(left.right, (right as typeof left).right);
  }
}

function inputSourcesEqual(
  left: JitInputSource,
  right: JitInputSource
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "reg":
      return right.kind === "reg" && left.reg === right.reg;
    case "flag":
      return right.kind === "flag" && left.flag === right.flag;
  }
}
