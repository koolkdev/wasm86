import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags
} from "#x86/flags.js";
import type { ConditionCode } from "#ir/model/types.js";
import { type FlagName } from "#ir/model/flags.js";
import type {
  JitFlagWriteCell,
  JitFlagWriteValue,
  JitValue
} from "./types.js";

export function flagWriteCellMask(cells: JitFlagWriteValue["cells"]): number {
  let mask = 0;

  for (const flag of x86ArithmeticFlags) {
    if (cells[flag] !== undefined) {
      mask |= x86ArithmeticFlagMask[flag];
    }
  }

  return mask;
}

export function flagWriteCellEntries(
  value: JitFlagWriteValue
): readonly (readonly [FlagName, JitFlagWriteCell])[] {
  return x86ArithmeticFlags.flatMap((flag) => {
    const cell = value.cells[flag];

    return cell === undefined ? [] : [[flag, cell] as const];
  });
}

export function flagWriteConditionEntries(
  value: JitFlagWriteValue
): readonly (readonly [ConditionCode, JitValue])[] {
  return Object.entries(value.conditions ?? {})
    .flatMap(([cc, condition]) =>
      condition === undefined ? [] : [[cc as ConditionCode, condition] as const]
    )
    .sort(([leftCc], [rightCc]) => leftCc.localeCompare(rightCc));
}

export function flagWriteChildValues(value: JitFlagWriteValue): readonly JitValue[] {
  return [
    ...flagWriteCellEntries(value).flatMap(([, cell]) => (cell.kind === "expr" ? [cell.value] : [])),
    ...flagWriteConditionEntries(value).map(([, condition]) => condition)
  ];
}

// Bit-narrowing drops cells outside the mask along with the conditions, which
// describe the full write rather than the surviving cells.
export function narrowFlagWriteToMask(value: JitFlagWriteValue, mask: number): JitFlagWriteValue {
  const cells: Record<string, JitFlagWriteCell> = {};

  for (const [flag, cell] of flagWriteCellEntries(value)) {
    if ((x86ArithmeticFlagMask[flag] & mask) !== 0) {
      cells[flag] = cell;
    }
  }

  return {
    kind: "flagWrite",
    cells,
    mask: value.mask & mask
  };
}

