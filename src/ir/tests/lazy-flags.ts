import { strictEqual } from "node:assert";

import type { WriteStateAction } from "#ir/actions.js";
import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#ir/lazy-flags.js";
import {
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel
} from "#ir/slots.js";
import type { ValueId, ValueTable } from "#ir/values.js";

export type LazyRecordExpectation = Readonly<
  | { kind: "ADD" | "SUB"; width: 8 | 16 | 32; left: ValueId; right: ValueId }
  | { kind: "LOGIC_RESULT"; width: 8 | 16 | 32; result: ValueId }
>;

export function assertLazyRecord(
  actions: readonly WriteStateAction[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  strictEqual(actions.filter((write) => write.slot.kind === "flag").length, 0);

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
  actions: readonly WriteStateAction[],
  values: ValueTable,
  expected: LazyRecordExpectation
): void {
  assertLazyRecord(actions, values, expected);
  strictEqual(actions.length, expected.kind === "LOGIC_RESULT" ? 2 : 3);
}

function stateWriteValue(actions: readonly WriteStateAction[], slot: WriteStateAction["slot"]): ValueId | undefined {
  return actions.find((write) => write.slot === slot)?.value;
}
