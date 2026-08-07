import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { i32, unreachable } from "#compiler/function/values.js";
import { foldNarrowValues } from "../fold.js";

test("narrow integer folding evaluates expressions in an isolated value scope", () => {
  deepStrictEqual(
    foldNarrowValues([i32(7).xor(8), i32(9).add(4), i32(0x101).truncate(8), unreachable()]),
    [15, 13, 1, undefined]
  );
});
