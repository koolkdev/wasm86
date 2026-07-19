import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { LAZY_FLAGS_KIND, lazyFlagsKindByte } from "#core/flags/lazy/encoding.js";

test("lazy flag state encodes its kind and operand width", () => {
  strictEqual(lazyFlagsKindByte(LAZY_FLAGS_KIND.NONE, 0), 0);
  deepStrictEqual(
    ([8, 16, 32] as const).map((width) => lazyFlagsKindByte(LAZY_FLAGS_KIND.SUB, width)),
    [1, 5, 9]
  );
  deepStrictEqual(
    ([8, 16, 32] as const).map((width) => lazyFlagsKindByte(LAZY_FLAGS_KIND.ADD, width)),
    [2, 6, 10]
  );
  deepStrictEqual(
    ([8, 16, 32] as const).map((width) => lazyFlagsKindByte(LAZY_FLAGS_KIND.LOGIC_RESULT, width)),
    [3, 7, 11]
  );
});
