import { execFileSync } from "node:child_process";
import { throws } from "node:assert";
import { test } from "node:test";

import { placeFunction } from "#compiler/placement/place.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionBuilder, type IrFunction } from "#ir/function.js";

test("validation builds validate IR before placement", () => {
  throws(() => placeFunction(incompleteFunction()), /root body does not complete/);
});

test("default builds skip IR validation before placement", () => {
  execFileSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "import { placeFunction } from '#compiler/placement/place.js'; " +
      "import { functionType } from '#compiler/program/function-type.js'; " +
      "import { FunctionBuilder } from '#ir/function.js'; " +
      "placeFunction(new FunctionBuilder(functionType([], [])).finish());"
  ]);
});

function incompleteFunction(): IrFunction {
  return new FunctionBuilder(functionType([], [])).finish();
}
