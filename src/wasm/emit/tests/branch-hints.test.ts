import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IfAction } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#ir/value-table.js";
import { fitsUnsigned } from "#ir/values.js";
import { pageFault } from "#core/exceptions.js";
import { wasmBranchHint } from "#wasm/encoder/function-body.js";
import { irBlockBody } from "./harness.js";

test("if branch hints come only from the explicit action hint", () => {
  deepStrictEqual(branchHintsForCheckIf(undefined), []);
  deepStrictEqual(branchHintsForCheckIf("unlikely"), [wasmBranchHint.unlikely]);
});

test("a static memory check byte length must be positive", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const byteLength = values.const(0);
  const condition = values.addActionOutput(fitsUnsigned(1));
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "op",
          output: condition,
          op: { kind: "memory.check", address, byteLength, access: "read" }
        },
        {
          kind: "if",
          condition,
          thenBody: {
            actions: [{ kind: "finish", finish: { kind: "exit", exit: { class: "host", reason: "unsupported" } } }]
          }
        },
        { kind: "finish", finish: { kind: "exit", exit: { class: "host", reason: "unsupported" } } }
      ]
    }
  };

  throws(() => irBlockBody(block), /guest access byte length must be positive, got 0/);
});

function branchHintsForCheckIf(hint: IfAction["hint"]): readonly number[] {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const byteLength = values.const(4);
  const condition = values.addActionOutput(fitsUnsigned(1));
  const block: IrBlock = {
    values,
    body: {
      actions: [
        {
          kind: "op",
          output: condition,
          op: { kind: "memory.check", address, byteLength, access: "read" }
        },
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
                  exit: { class: "cpuException", exception: pageFault(address, 0) }
                }
              }
            ]
          }
        },
        { kind: "finish", finish: { kind: "exit", exit: { class: "host", reason: "unsupported" } } }
      ]
    }
  };

  return irBlockBody(block).encodeWithMetadata().branchHints.map((entry) => entry.value);
}
