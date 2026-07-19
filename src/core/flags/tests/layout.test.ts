import { strictEqual } from "node:assert";
import { test } from "node:test";

import { FieldRef } from "#compiler/layout/handles.js";
import { x86Flags } from "#core/flags/definitions.js";
import {
  flagStateFields,
  isConcreteFlagStateField,
  isLazyFlagStateField
} from "#core/flags/layout.js";

test("concrete flags use individual byte fields", () => {
  for (const flag of x86Flags) {
    strictEqual(flagStateFields.concrete[flag].width, "u8");
  }
});

test("flag field classes use their declared identities", () => {
  for (const flag of x86Flags) {
    const field = flagStateFields.concrete[flag];

    strictEqual(isConcreteFlagStateField(field), true);
    strictEqual(isLazyFlagStateField(field), false);
  }

  for (const field of [
    flagStateFields.lazyKind,
    flagStateFields.lazyA,
    flagStateFields.lazyB
  ]) {
    strictEqual(isConcreteFlagStateField(field), false);
    strictEqual(isLazyFlagStateField(field), true);
  }

  const copiedField = new FieldRef(
    flagStateFields.lazyKind.id,
    flagStateFields.lazyKind.width
  );

  strictEqual(isConcreteFlagStateField(copiedField), false);
  strictEqual(isLazyFlagStateField(copiedField), false);
});
