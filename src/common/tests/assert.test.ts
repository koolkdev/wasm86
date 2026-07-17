import { execFileSync } from "node:child_process";
import { throws } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";

test("test builds enable assertions", () => {
  throws(() => assert(false, "active test assertion"), /active test assertion/);
});

test("default builds disable assertions", () => {
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    'import { assert } from "#common/assert.js"; assert(false, "disabled assertion");'
  ]);
});
