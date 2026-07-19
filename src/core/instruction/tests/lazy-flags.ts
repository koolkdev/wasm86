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
  type StateWriteOperation
} from "./state-operations.js";

export type LazyRecordExpectation = Readonly<
  | { kind: "ADD" | "SUB"; width: 8 | 16 | 32; left: ValueId; right: ValueId }
  | { kind: "LOGIC_RESULT"; width: 8 | 16 | 32; result: ValueId }
>;

export function assertLazyRecord(
  nodes: readonly StateWriteOperation[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  strictEqual(
    nodes.filter((write) =>
      x86Flags.some((flag) =>
        writesStateChannel(values, write, flagStateFields.concrete[flag])
      )
    ).length,
    0
  );

  if (expected.kind === "LOGIC_RESULT") {
    strictEqual(
      stateFieldWriteValue(nodes, values, flagStateFields.lazyA),
      values.truncate(expected.width, expected.result)
    );
    strictEqual(stateFieldWriteValue(nodes, values, flagStateFields.lazyB), undefined);
  } else {
    strictEqual(
      stateFieldWriteValue(nodes, values, flagStateFields.lazyA),
      values.truncate(expected.width, expected.left)
    );
    strictEqual(
      stateFieldWriteValue(nodes, values, flagStateFields.lazyB),
      values.truncate(expected.width, expected.right)
    );
  }

  strictEqual(
    stateFieldWriteValue(nodes, values, flagStateFields.lazyKind),
    values.const(lazyFlagsKindByte(LAZY_FLAGS_KIND[expected.kind], expected.width))
  );
}

export function assertOnlyLazyRecord(
  nodes: readonly StateWriteOperation[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  assertLazyRecord(nodes, values, expected);
  strictEqual(nodes.length, expected.kind === "LOGIC_RESULT" ? 2 : 3);
}

function stateFieldWriteValue(
  nodes: readonly StateWriteOperation[],
  values: ValueTable,
  field: FlagStateField
): ValueId | undefined {
  const write = nodes.find((node) =>
    writesStateChannel(values, node, field)
  );

  return write === undefined ? undefined : stateWriteValue(write);
}
