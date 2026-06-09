import { type OperandWidth } from "#x86/types.js";
import {
  x86ArithmeticFlagMask,
  x86ArithmeticFlags
} from "#x86/flags.js";
import type { ConditionCode, FlagProducerName } from "#ir/model/types.js";
import {
  FLAG_PRODUCERS,
  flagProducerInputNames,
  requiredFlagProducerInput,
  type FlagName
} from "#ir/model/flags.js";
import { IR_ALU_FLAG_MASK, assertIrAluFlagMask } from "#ir/model/flag-effects.js";
import type {
  JitFlagProducerValue,
  JitFlagWriteCell,
  JitFlagWriteValue,
  JitValue
} from "./types.js";

export function normalizeFlagProducerMask(producer: FlagProducerName, mask: number): number {
  assertIrAluFlagMask(mask, "flagProducer mask");
  const writtenMask = FLAG_PRODUCERS[producer].writtenMask;

  if ((mask & ~writtenMask) !== 0) {
    throw new Error(`flagProducer mask includes bits not written by ${producer}`);
  }

  return mask & IR_ALU_FLAG_MASK;
}

export function normalizeOptionalWidth(width: OperandWidth | undefined): OperandWidth | undefined {
  if (width === undefined || width === 32) {
    return undefined;
  }

  if (!isOperandWidth(width)) {
    throw new Error(`JIT value width is not supported: ${width}`);
  }

  return width;
}

export function flagProducerWidth(value: Pick<JitFlagProducerValue, "width">): OperandWidth {
  return value.width ?? 32;
}

export function flagProducerInputValues(value: JitFlagProducerValue): readonly JitValue[] {
  return flagProducerInputNames(value.producer).map((key) =>
    requiredFlagProducerInput(value.producer, value.inputs, key)
  );
}

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

function isOperandWidth(width: number): width is OperandWidth {
  return width === 8 || width === 16 || width === 32;
}
