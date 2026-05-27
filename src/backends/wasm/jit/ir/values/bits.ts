import { widthMask, type OperandWidth } from "#x86/types.js";

export function bitRangeMask(bitOffset: number, width: OperandWidth): number {
  return width === 32 ? 0xffff_ffff : ((widthMask(width) << bitOffset) >>> 0);
}

export function bitRangeRelationship(
  leftOffset: number,
  leftWidth: OperandWidth,
  rightOffset: number,
  rightWidth: OperandWidth
): "same" | "disjoint" | "overlap" {
  const leftEnd = leftOffset + leftWidth;
  const rightEnd = rightOffset + rightWidth;

  if (leftOffset === rightOffset && leftWidth === rightWidth) {
    return "same";
  }

  return leftEnd <= rightOffset || rightEnd <= leftOffset ? "disjoint" : "overlap";
}

export function assertBitRange(bitOffset: number, width: OperandWidth, context: string): void {
  if (
    !Number.isInteger(bitOffset) ||
    bitOffset < 0 ||
    !isOperandWidth(width) ||
    bitOffset + width > 32
  ) {
    throw new Error(`${context} range must fit in 32 bits`);
  }
}

export function normalizeU32Mask(mask: number, context: string): number {
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xffff_ffff) {
    throw new Error(`${context} must be a 32-bit unsigned mask`);
  }

  return mask >>> 0;
}

function isOperandWidth(width: number): width is OperandWidth {
  return width === 8 || width === 16 || width === 32;
}
