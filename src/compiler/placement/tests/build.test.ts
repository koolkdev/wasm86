import { execFileSync } from "node:child_process";
import { throws } from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";
import { placeBody } from "#compiler/placement/place.js";
import type { IrBlock } from "#ir/block.js";

test("validation builds validate IR before placement", () => {
  throws(() => placeBody(incompleteBlock()), /root body does not complete/);
});

test("default builds skip IR validation before placement", () => {
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { ValueTable } from '#compiler/ir/values/table.js'; " +
      "import { placeBody } from '#compiler/placement/place.js'; " +
      "placeBody({ values: new ValueTable(), body: { nodes: [] } });"
  ]);
});

function incompleteBlock(): IrBlock {
  return {
    values: new ValueTable(),
    body: { nodes: [] }
  };
}
