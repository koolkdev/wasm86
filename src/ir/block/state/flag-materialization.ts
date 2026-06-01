import { exprInput } from "#ir/expr/builders.js";
import { exprsEqual } from "#ir/expr/equality.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { FlagName } from "#ir/model/flags.js";
import {
  type FlagCell,
  type FlagState
} from "./flag-state.js";

export type FlagMaterializationWrite = Readonly<{
  flag: FlagName;
  value: ExprRef | undefined;
}>;

export function flagMaterializationWrites(
  baseline: FlagState,
  snapshot: FlagState
): readonly FlagMaterializationWrite[] {
  const writes: FlagMaterializationWrite[] = [];

  for (const { flag, cell } of snapshot.cells()) {
    const baselineValue = cellVisibleValue(flag, baseline.read(flag));
    const snapshotValue = cellVisibleValue(flag, cell);

    if (visibleValuesEqual(baselineValue, snapshotValue)) {
      continue;
    }

    writes.push(Object.freeze({
      flag,
      value: snapshotValue
    } satisfies FlagMaterializationWrite));
  }

  return Object.freeze(writes);
}

function visibleValuesEqual(
  left: ExprRef | undefined,
  right: ExprRef | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return exprsEqual(left, right);
}

function cellVisibleValue(flag: FlagName, cell: FlagCell): ExprRef | undefined {
  switch (cell.kind) {
    case "expr":
      return cell.value;
    case "input":
      return exprInput({ kind: "flag", flag });
    case "undef":
      return undefined;
  }
}
