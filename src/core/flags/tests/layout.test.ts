import { strictEqual } from "node:assert";
import { test } from "node:test";

import { x86Flags } from "#core/flags/definitions.js";
import {
  flagStateFields,
  isConcreteFlagStateField,
  isLazyFlagStateField
} from "#core/flags/layout.js";

test("concrete flags store one-bit values in individual byte fields", () => {
  for (const flag of x86Flags) {
    const field = flagStateFields.concrete[flag];

    strictEqual(field.width, "u8");
    strictEqual(field.valueWidth, 1);
  }
});

test("flag field classes use their declared identities", () => {
  for (const flag of x86Flags) {
    const field = flagStateFields.concrete[flag];

    strictEqual(isConcreteFlagStateField(field), true);
    strictEqual(isLazyFlagStateField(field), false);
  }

  for (const field of [flagStateFields.lazyKind, flagStateFields.lazyA, flagStateFields.lazyB]) {
    strictEqual(isConcreteFlagStateField(field), false);
    strictEqual(isLazyFlagStateField(field), true);
  }
});
