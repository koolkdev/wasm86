import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { analyzeBody } from "#compiler/analysis/analyze.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { helperCallsForAnalysis } from "#wasm/helpers/module.js";
import { resolveFlag, stateWrite } from "#ir/tests/storage-op-helpers.js";

function helperCalls(block: IrBlock) {
  validateIrBlock(block, { allowImplicitEntryFallthrough: true });
  return helperCallsForAnalysis(analyzeBody(block));
}

test("helperCallsForAnalysis reports live flag resolves", () => {
  const values = new ValueTable();
  const zf = values.addActionOutput(fitsUnsigned(1));
  const block = {
    body: {
      actions: [
        resolveFlag(zf, "ZF"),
        stateWrite(gprChannel("eax"), zf)
      ]
    },
    values
  } as const;

  deepStrictEqual(helperCalls(block), [
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});

test("helperCallsForAnalysis omits dead flag resolves", () => {
  const values = new ValueTable();
  const zf = values.addActionOutput(fitsUnsigned(1));

  const block = {
    body: { actions: [resolveFlag(zf, "ZF")] },
    values
  } as const;

  deepStrictEqual(helperCalls(block), []);
});

test("helperCallsForAnalysis preserves first-use order while deduplicating", () => {
  const values = new ValueTable();
  const first = values.addActionOutput(fitsUnsigned(1));
  const second = values.addActionOutput(fitsUnsigned(1));
  const duplicate = values.addActionOutput(fitsUnsigned(1));
  const block = {
    body: {
      actions: [
        resolveFlag(first, "ZF"),
        resolveFlag(second, "CF"),
        resolveFlag(duplicate, "ZF"),
        stateWrite(gprChannel("eax"), first),
        stateWrite(gprChannel("ebx"), second),
        stateWrite(gprChannel("ecx"), duplicate)
      ]
    },
    values
  } as const;

  deepStrictEqual(helperCalls(block), [
    { kind: "lazyFlag", flag: "ZF" },
    { kind: "lazyFlag", flag: "CF" }
  ]);
});
