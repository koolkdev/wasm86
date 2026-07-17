import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { IfAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { pageFault } from "#core/exceptions.js";
import { buildException } from "#cpu/exit.js";
import { wasmBranchHint } from "#compiler/encoder/function-body.js";
import { irBlockBody } from "./harness.js";

test("if branch hints come only from the explicit action hint", () => {
  deepStrictEqual(branchHintsForCheckIf(undefined), []);
  deepStrictEqual(branchHintsForCheckIf("unlikely"), [wasmBranchHint.unlikely]);
});

function branchHintsForCheckIf(hint: IfAction["hint"]): readonly number[] {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const condition = values.const(1);
  const pageFaultResult = buildException(values, pageFault(address, 0));
  const fallbackResult = values.const64(0n);
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "if",
          condition,
          ...(hint === undefined ? {} : { hint }),
          thenBody: {
            actions: [
              {
                kind: "finish",
                finish: {
                  kind: "exit",
                  result: pageFaultResult
                }
              }
            ]
          }
        },
        { kind: "finish", finish: { kind: "exit", result: fallbackResult } }
      ]
    }
  };

  return irBlockBody(block).branchHints.map((entry) => entry.value);
}
