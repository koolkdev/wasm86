import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import type { IfAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable, fitsUnsigned } from "#ir/values.js";
import { wasmBranchHint } from "#wasm/encoder/function-body.js";
import { irBlockBody } from "./harness.js";

test("if branch hints come only from the explicit action hint", () => {
  deepStrictEqual(branchHintsForCheckIf(undefined), []);
  deepStrictEqual(branchHintsForCheckIf("unlikely"), [wasmBranchHint.unlikely]);
});

function branchHintsForCheckIf(hint: IfAction["hint"]): readonly number[] {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const condition = values.addActionOutput(fitsUnsigned(1));
  const block: IrBlock = {
    values,
    body: {
      actions: [
        { kind: "op", output: condition, op: { kind: "memory.check", address, byteLength: 4, access: "read" } },
        {
          kind: "if",
          condition,
          ...(hint === undefined ? {} : { hint }),
          thenBody: {
            actions: [
              { kind: "finish", finish: { kind: "exit", reason: "memoryReadFault", payload: address, detail: 4 } }
            ]
          }
        },
        { kind: "finish", finish: { kind: "exit", reason: "unsupported" } }
      ]
    }
  };

  return irBlockBody(block).encodeWithMetadata().branchHints.map((entry) => entry.value);
}
