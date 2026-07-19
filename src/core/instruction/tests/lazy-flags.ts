import { strictEqual } from "node:assert";

import type { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { x86Flags } from "#core/flags/definitions.js";
import {
  flagStateFields,
  type FlagStateField
} from "#core/flags/layout.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";
import {
  stateWriteValue,
  writesStateChannel,
  type StateWriteAction
} from "./state-actions.js";

export type LazyRecordExpectation = Readonly<
  | { kind: "ADD" | "SUB"; width: 8 | 16 | 32; left: ValueId; right: ValueId }
  | { kind: "LOGIC_RESULT"; width: 8 | 16 | 32; result: ValueId }
>;

export function assertLazyRecord(
  actions: readonly StateWriteAction[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  strictEqual(
    actions.filter((write) =>
      x86Flags.some((flag) =>
        writesStateChannel(values, write, flagStateFields.concrete[flag])
      )
    ).length,
    0
  );

  if (expected.kind === "LOGIC_RESULT") {
    strictEqual(
      stateFieldWriteValue(actions, values, flagStateFields.lazyA),
      values.truncate(expected.width, expected.result)
    );
    strictEqual(stateFieldWriteValue(actions, values, flagStateFields.lazyB), undefined);
  } else {
    strictEqual(
      stateFieldWriteValue(actions, values, flagStateFields.lazyA),
      values.truncate(expected.width, expected.left)
    );
    strictEqual(
      stateFieldWriteValue(actions, values, flagStateFields.lazyB),
      values.truncate(expected.width, expected.right)
    );
  }

  strictEqual(
    stateFieldWriteValue(actions, values, flagStateFields.lazyKind),
    values.const(lazyFlagsKindByte(LAZY_FLAGS_KIND[expected.kind], expected.width))
  );
}

export function assertOnlyLazyRecord(
  actions: readonly StateWriteAction[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  assertLazyRecord(actions, values, expected);
  strictEqual(actions.length, expected.kind === "LOGIC_RESULT" ? 2 : 3);
}

function stateFieldWriteValue(
  actions: readonly StateWriteAction[],
  values: ValueTable,
  field: FlagStateField
): ValueId | undefined {
  const write = actions.find((action) =>
    writesStateChannel(values, action, field)
  );

  return write === undefined ? undefined : stateWriteValue(write);
}
