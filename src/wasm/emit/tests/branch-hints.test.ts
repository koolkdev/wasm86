import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { IfControl } from "#compiler/ir/controls/index.js";
import { pageFault } from "#core/exceptions.js";
import { exceptionExit } from "#core/exits.js";
import { buildExit } from "#cpu/exit.js";
import { wasmBranchHint } from "#compiler/encoder/function-body.js";
import { testFunction, testFunctionBranchHints } from "./harness.js";

test("if branch hints come only from the explicit action hint", () => {
  deepStrictEqual(branchHintsForCheckIf(undefined), []);
  deepStrictEqual(branchHintsForCheckIf("unlikely"), [wasmBranchHint.unlikely]);
});

function branchHintsForCheckIf(hint: IfControl["hint"]): readonly number[] {
  const fixture = testFunction(0, (fn) => {
    const values = fn.values;
    const address = values.const(0x2000);
    const condition = values.const(1);
    const pageFaultResult = buildExit(
      values,
      exceptionExit(pageFault(address, values.const(0)))
    );

    fn.region.if(
      condition,
      (arm) => arm.return([pageFaultResult]),
      hint === undefined ? {} : { hint }
    );
    fn.return([values.const64(0n)]);
  });

  return testFunctionBranchHints(fixture);
}
