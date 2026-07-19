import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import {
  finishControl,
  ifControl,
  type IfControl
} from "#compiler/ir/controls/index.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { pageFault } from "#core/exceptions.js";
import { exceptionExit } from "#core/exits.js";
import { buildExit } from "#cpu/exit.js";
import { wasmBranchHint } from "#compiler/encoder/function-body.js";
import { irBlockBody } from "./harness.js";

test("if branch hints come only from the explicit action hint", () => {
  deepStrictEqual(branchHintsForCheckIf(undefined), []);
  deepStrictEqual(branchHintsForCheckIf("unlikely"), [wasmBranchHint.unlikely]);
});

function branchHintsForCheckIf(hint: IfControl["hint"]): readonly number[] {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const condition = values.const(1);
  const pageFaultResult = buildExit(
    values,
    exceptionExit(pageFault(address, values.const(0)))
  );
  const fallbackResult = values.const64(0n);
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        ifControl.create({
          condition,
          ...(hint === undefined ? {} : { hint }),
          thenBody: {
            nodes: [
              finishControl.create({
                finish: {
                  kind: "exit",
                  result: pageFaultResult
                }
              })
            ]
          }
        }),
        finishControl.create({
          finish: { kind: "exit", result: fallbackResult }
        })
      ]
    }
  };

  return irBlockBody(block).branchHints.map((entry) => entry.value);
}
