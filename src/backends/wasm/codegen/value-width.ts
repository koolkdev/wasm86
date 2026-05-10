import type { IrBinaryOperator } from "#x86/ir/model/types.js";
import { widthMask, type OperandWidth } from "#x86/isa/types.js";
import { i32 } from "#x86/state/cpu-state.js";
import type { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";

export type ValueWidth = Readonly<{
  logicalWidth: OperandWidth;
  cleanWidth?: OperandWidth;
  highBitsMayBeDirty?: boolean;
  constValue?: number;
}>;

export type WasmIrEmitValueOptions = Readonly<{
  widthInsensitive?: boolean;
  requestedWidth?: OperandWidth;
  signed?: boolean;
}>;

export function untrackedValueWidth(): ValueWidth {
  return { logicalWidth: 32, cleanWidth: 32 };
}

export function cleanValueWidth(width: OperandWidth, constValue?: number): ValueWidth {
  return constValue === undefined
    ? { logicalWidth: width, cleanWidth: width }
    : { logicalWidth: width, cleanWidth: width, constValue: constValue >>> 0 };
}

export function dirtyValueWidth(width: OperandWidth): ValueWidth {
  return width === 32
    ? cleanValueWidth(32)
    : { logicalWidth: width, highBitsMayBeDirty: true };
}

export function constValueWidth(value: number): ValueWidth {
  const constValue = value >>> 0;

  return cleanValueWidth(smallestCleanWidth(constValue), constValue);
}

export function emitMaskValueToWidth(
  body: WasmFunctionBodyEncoder,
  width: OperandWidth,
  valueWidth: ValueWidth = untrackedValueWidth()
): ValueWidth {
  if (width === 32 || valueWidthIsCleanForWidth(valueWidth, width)) {
    return valueWidth;
  }

  body.i32Const(widthMask(width)).i32And();
  return cleanValueWidth(width, valueWidth.constValue === undefined ? undefined : maskConstToWidth(valueWidth.constValue, width));
}

export function emitCleanValueForFullUse(
  body: WasmFunctionBodyEncoder,
  valueWidth: ValueWidth = untrackedValueWidth()
): ValueWidth {
  if (valueWidth.highBitsMayBeDirty === true && valueWidth.logicalWidth < 32) {
    return emitMaskValueToWidth(body, valueWidth.logicalWidth, valueWidth);
  }

  return valueWidth;
}

export function emitSignExtendValueToWidth(
  body: WasmFunctionBodyEncoder,
  width: 8 | 16
): ValueWidth {
  switch (width) {
    case 8:
      body.i32Extend8S();
      break;
    case 16:
      body.i32Extend16S();
      break;
  }

  return cleanValueWidth(32);
}

export function maskedConstValue(value: number, width: OperandWidth): number {
  return i32(maskConstToWidth(value, width));
}

export function valueWidthIsCleanForWidth(valueWidth: ValueWidth, width: OperandWidth): boolean {
  return valueWidth.cleanWidth !== undefined && valueWidth.cleanWidth <= width;
}

export function i32BinaryResultValueWidth(
  operator: IrBinaryOperator,
  left: ValueWidth,
  right: ValueWidth
): ValueWidth {
  switch (operator) {
    case "add":
    case "sub":
      return arithmeticResultValueWidth(operator, left, right);
    case "and":
    case "or":
    case "xor":
      return bitwiseResultValueWidth(operator, left, right);
    case "shl":
      return shiftResultValueWidth(left, right);
    case "shr_u":
      return untrackedValueWidth();
  }
}

export function i32SelectResultValueWidth(
  condition: ValueWidth,
  whenTrue: ValueWidth,
  whenFalse: ValueWidth
): ValueWidth {
  if (condition.constValue !== undefined) {
    return condition.constValue !== 0 ? whenTrue : whenFalse;
  }

  if (
    whenTrue.constValue !== undefined &&
    whenFalse.constValue !== undefined &&
    whenTrue.constValue === whenFalse.constValue
  ) {
    return constValueWidth(whenTrue.constValue);
  }

  if (whenTrue.cleanWidth !== undefined && whenFalse.cleanWidth !== undefined) {
    return cleanValueWidth(maxWidth(whenTrue.cleanWidth, whenFalse.cleanWidth));
  }

  const logicalWidth = maxWidth(whenTrue.logicalWidth, whenFalse.logicalWidth);

  return logicalWidth === 32 ? untrackedValueWidth() : dirtyValueWidth(logicalWidth);
}

function bitwiseResultValueWidth(
  operator: Extract<IrBinaryOperator, "and" | "or" | "xor">,
  left: ValueWidth,
  right: ValueWidth
): ValueWidth {
  if (left.constValue !== undefined && right.constValue !== undefined) {
    switch (operator) {
      case "and":
        return constValueWidth(left.constValue & right.constValue);
      case "or":
        return constValueWidth(left.constValue | right.constValue);
      case "xor":
        return constValueWidth(left.constValue ^ right.constValue);
    }
  }

  if (operator === "and") {
    const maskWidth = maskValueWidth(left) ?? maskValueWidth(right);

    if (maskWidth !== undefined) {
      return cleanValueWidth(maskWidth);
    }

    const cleanWidth = minCleanWidth(left.cleanWidth, right.cleanWidth);

    if (cleanWidth !== undefined) {
      return cleanValueWidth(cleanWidth);
    }
  }

  if (left.cleanWidth !== undefined && right.cleanWidth !== undefined) {
    return cleanValueWidth(maxWidth(left.cleanWidth, right.cleanWidth));
  }

  const logicalWidth = maxWidth(left.logicalWidth, right.logicalWidth);

  return logicalWidth === 32 ? untrackedValueWidth() : dirtyValueWidth(logicalWidth);
}

function arithmeticResultValueWidth(
  operator: Extract<IrBinaryOperator, "add" | "sub">,
  left: ValueWidth,
  right: ValueWidth
): ValueWidth {
  if (left.constValue !== undefined && right.constValue !== undefined) {
    switch (operator) {
      case "add":
        return constValueWidth(left.constValue + right.constValue);
      case "sub":
        return constValueWidth(left.constValue - right.constValue);
    }
  }

  const logicalWidth = maxWidth(left.logicalWidth, right.logicalWidth);

  return logicalWidth === 32 ? untrackedValueWidth() : dirtyValueWidth(logicalWidth);
}

function shiftResultValueWidth(left: ValueWidth, right: ValueWidth): ValueWidth {
  if (left.constValue !== undefined && right.constValue !== undefined) {
    return constValueWidth(i32(left.constValue << (right.constValue & 31)));
  }

  return untrackedValueWidth();
}

export function maskWidthFromConstValue(value: number): OperandWidth | undefined {
  const normalized = value >>> 0;

  switch (normalized) {
    case 0xff:
      return 8;
    case 0xffff:
      return 16;
    case 0xffff_ffff:
      return 32;
    default:
      return undefined;
  }
}

function maskValueWidth(valueWidth: ValueWidth): OperandWidth | undefined {
  return valueWidth.constValue === undefined ? undefined : maskWidthFromConstValue(valueWidth.constValue);
}

function minCleanWidth(left: OperandWidth | undefined, right: OperandWidth | undefined): OperandWidth | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  return left <= right ? left : right;
}

function maxWidth(left: OperandWidth, right: OperandWidth): OperandWidth {
  return left >= right ? left : right;
}

function smallestCleanWidth(value: number): OperandWidth {
  if (value <= 0xff) {
    return 8;
  }

  if (value <= 0xffff) {
    return 16;
  }

  return 32;
}

function maskConstToWidth(value: number, width: OperandWidth): number {
  return (value & widthMask(width)) >>> 0;
}
