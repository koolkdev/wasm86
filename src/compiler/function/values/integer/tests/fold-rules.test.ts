import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { foldExtend, foldTruncate } from "../fold-rules.js";

test("constant fold outcomes carry the outcome width's normal form", () => {
  deepStrictEqual(foldExtend(16, 8, true, { constant: 0xffn }), {
    kind: "constant",
    value: 0xffffn
  });
  deepStrictEqual(foldTruncate(8, { constant: 0x1ffn }), { kind: "constant", value: 0xffn });
});
