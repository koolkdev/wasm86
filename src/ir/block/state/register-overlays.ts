import { registerAliasesByWidth } from "#x86/registers.js";
import type { OperandWidth, Reg32, RegisterAlias } from "#x86/types.js";
import {
  exprBits,
  exprConst,
  exprInsertBits,
  exprProject
} from "#ir/expr/builders.js";
import { canonicalizeExpr } from "#ir/expr/canonicalize.js";
import type { ExprRef } from "#ir/expr/types.js";

type RegisterAliasWrite = Readonly<{
  reg: RegisterAlias;
  value: ExprRef;
}>;

export type RegisterMaterializationWrite = Readonly<{
  reg: RegisterAlias;
  value: ExprRef;
}>;

type BitRange = Readonly<{
  start: number;
  end: number;
}>;

export function registerAliasWrite(
  reg: RegisterAlias,
  value: ExprRef
): RegisterAliasWrite {
  return Object.freeze({
    reg,
    value: canonicalizeExpr(value)
  });
}

export function registerMaterializationWrite(
  reg: RegisterAlias,
  value: ExprRef
): RegisterMaterializationWrite {
  return Object.freeze({
    reg,
    value: canonicalizeExpr(value)
  });
}

export function materializeRegisterBase(
  baseValue: ExprRef,
  overlays: readonly RegisterAliasWrite[]
): ExprRef {
  let value = baseValue;

  for (const write of overlays) {
    value = canonicalizeExpr(
      exprInsertBits(value, write.value, write.reg.bitOffset, write.reg.width)
    );
  }

  return value;
}

export function readRegisterAlias(
  baseValue: ExprRef,
  overlays: readonly RegisterAliasWrite[],
  alias: RegisterAlias
): ExprRef {
  const requestedRange = aliasRange(alias);
  const overlayRanges = overlays.map((write) => aliasRange(write.reg));
  let value = rangeIsCovered(requestedRange, overlayRanges)
    ? exprConst(0)
    : aliasValueFromBase(baseValue, alias);

  for (const write of overlays) {
    const intersection = intersectRanges(requestedRange, aliasRange(write.reg));

    if (intersection === undefined) {
      continue;
    }

    const width = operandWidth(intersection.end - intersection.start);
    const sourceOffset = intersection.start - write.reg.bitOffset;
    const targetOffset = intersection.start - alias.bitOffset;
    const sourceValue = aliasValuePart(write.value, sourceOffset, width);

    value = targetOffset === 0 && width === alias.width
      ? sourceValue
      : canonicalizeExpr(exprInsertBits(value, sourceValue, targetOffset, width));
  }

  return value;
}

export function normalizeRegisterOverlayWrites(
  overlays: readonly RegisterAliasWrite[],
  write: RegisterAliasWrite
): readonly RegisterAliasWrite[] {
  const ordered = [...overlays, write];
  const kept: RegisterAliasWrite[] = [];
  const covered: BitRange[] = [];

  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const candidate = ordered[index]!;
    const range = aliasRange(candidate.reg);

    if (rangeIsCovered(range, covered)) {
      continue;
    }

    kept.push(candidate);
    covered.push(range);
  }

  return Object.freeze(kept.reverse());
}

export function resetWritesForUncoveredOverlay(
  write: RegisterAliasWrite,
  coveredOverlays: readonly RegisterAliasWrite[],
  baseValue: ExprRef
): readonly RegisterMaterializationWrite[] {
  const coveredRanges = coveredOverlays.map((overlay) => aliasRange(overlay.reg));
  const uncovered = subtractRanges(aliasRange(write.reg), coveredRanges);
  const writes: RegisterMaterializationWrite[] = [];

  for (const range of uncovered) {
    const alias = aliasForRange(write.reg.base, range);

    if (alias === undefined) {
      return [
        registerMaterializationWrite(write.reg, aliasValueFromBase(baseValue, write.reg))
      ];
    }

    writes.push(registerMaterializationWrite(alias, aliasValueFromBase(baseValue, alias)));
  }

  return Object.freeze(writes);
}

function aliasValueFromBase(value: ExprRef, alias: RegisterAlias): ExprRef {
  return aliasValuePart(value, alias.bitOffset, alias.width);
}

function aliasValuePart(value: ExprRef, bitOffset: number, width: OperandWidth): ExprRef {
  if (bitOffset === 0 && width === 32) {
    return canonicalizeExpr(value);
  }

  return canonicalizeExpr(
    bitOffset === 0
      ? exprProject(width, value)
      : exprBits(value, bitOffset, width)
  );
}

function rangeIsCovered(range: BitRange, ranges: readonly BitRange[]): boolean {
  let cursor = range.start;

  for (const covered of ranges
    .filter((candidate) => rangesOverlap(range, candidate))
    .sort((left, right) => left.start - right.start)) {
    if (covered.start > cursor) {
      return false;
    }

    cursor = Math.max(cursor, covered.end);

    if (cursor >= range.end) {
      return true;
    }
  }

  return false;
}

function subtractRanges(range: BitRange, coveredRanges: readonly BitRange[]): readonly BitRange[] {
  let cursor = range.start;
  const uncovered: BitRange[] = [];

  for (const covered of coveredRanges
    .filter((candidate) => rangesOverlap(range, candidate))
    .sort((left, right) => left.start - right.start)) {
    if (covered.start > cursor) {
      uncovered.push(Object.freeze({
        start: cursor,
        end: Math.min(covered.start, range.end)
      }));
    }

    cursor = Math.max(cursor, covered.end);

    if (cursor >= range.end) {
      return Object.freeze(uncovered);
    }
  }

  if (cursor < range.end) {
    uncovered.push(Object.freeze({ start: cursor, end: range.end }));
  }

  return Object.freeze(uncovered);
}

function rangesOverlap(left: BitRange, right: BitRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function intersectRanges(left: BitRange, right: BitRange): BitRange | undefined {
  const start = Math.max(left.start, right.start);
  const end = Math.min(left.end, right.end);

  return start < end ? Object.freeze({ start, end }) : undefined;
}

function aliasRange(alias: RegisterAlias): BitRange {
  return Object.freeze({
    start: alias.bitOffset,
    end: alias.bitOffset + alias.width
  });
}

function aliasForRange(base: Reg32, range: BitRange): RegisterAlias | undefined {
  const width = optionalOperandWidth(range.end - range.start);

  if (width === undefined) {
    return undefined;
  }

  return registerAliasesByWidth[width].find((alias) =>
    alias.base === base &&
    alias.bitOffset === range.start
  );
}

function optionalOperandWidth(width: number): OperandWidth | undefined {
  return width === 8 || width === 16 || width === 32 ? width : undefined;
}

function operandWidth(width: number): OperandWidth {
  if (width === 8 || width === 16 || width === 32) {
    return width;
  }

  throw new Error(`register alias intersection width must be 8, 16, or 32: ${width}`);
}
