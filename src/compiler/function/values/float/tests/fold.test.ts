import { strictEqual } from "node:assert";
import { test } from "node:test";

import { ValueScope } from "#compiler/function/values/scope.js";
import { f32 } from "#compiler/function/values.js";
import { foldFloatBinary } from "../fold.js";

test("NaN results stay unfolded because Wasm leaves their payload undetermined", () => {
  const values = new ValueScope();
  const zero = f32(0);

  values.resolve(zero);
  strictEqual(foldFloatBinary("div", 32, values.factOf(zero), values.factOf(zero)), undefined);
});
