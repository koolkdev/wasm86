import { throws } from "node:assert";
import { test } from "node:test";

import { functionExportRef } from "#compiler/program/exports.js";

test("function export refs require a nonempty identity", () => {
  throws(() => functionExportRef(""), /empty function-export identity/);
});
