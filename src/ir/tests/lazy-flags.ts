import { strictEqual } from "node:assert";

import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#ir/lazy-flags.js";
import {
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel
} from "#ir/slots.js";
import type { ValueId, ValueTable } from "#ir/values.js";
import type { StateWriteAction } from "#ir/tests/storage-op-helpers.js";

export type LazyRecordExpectation = Readonly<
  | { kind: "ADD" | "SUB"; width: 8 | 16 | 32; left: ValueId; right: ValueId }
  | { kind: "LOGIC_RESULT"; width: 8 | 16 | 32; result: ValueId }
>;

export function assertLazyRecord(
  actions: readonly StateWriteAction[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  strictEqual(actions.filter((write) => write.op.slot.kind === "flag").length, 0);

  if (expected.kind === "LOGIC_RESULT") {
    strictEqual(stateWriteValue(actions, lazyFlagsAChannel), values.truncate(expected.width, expected.result));
    strictEqual(stateWriteValue(actions, lazyFlagsBChannel), undefined);
  } else {
    strictEqual(stateWriteValue(actions, lazyFlagsAChannel), values.truncate(expected.width, expected.left));
    strictEqual(stateWriteValue(actions, lazyFlagsBChannel), values.truncate(expected.width, expected.right));
  }

  strictEqual(
    stateWriteValue(actions, lazyFlagsKindChannel),
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

function stateWriteValue(actions: readonly StateWriteAction[], slot: StateWriteAction["op"]["slot"]): ValueId | undefined {
  return actions.find((write) => write.op.slot === slot)?.op.value;
}
