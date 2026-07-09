import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/slots.js";
import type { IrBlock } from "#ir/block.js";
import { validateIrBlock } from "#ir/validate.js";
import { ValueTable } from "#ir/value-table.js";
import { fitsUnsigned } from "#ir/values.js";
import { analyzeLiveness } from "#wasm/emit/liveness.js";
import { helperCallsForBlock } from "#wasm/helpers/module.js";
import { resolveFlag, stateWrite } from "#ir/tests/storage-op-helpers.js";

function helperCalls(block: IrBlock) {
  validateIrBlock(block, { allowImplicitEntryFallthrough: true });
  return helperCallsForBlock(block, analyzeLiveness(block));
}

test("helperCallsForBlock reports live flag resolves", () => {
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

test("helperCallsForBlock omits dead flag resolves", () => {
  const values = new ValueTable();
  const zf = values.addActionOutput(fitsUnsigned(1));

  const block = {
    body: { actions: [resolveFlag(zf, "ZF")] },
    values
  } as const;

  deepStrictEqual(helperCalls(block), []);
});

test("helperCallsForBlock deduplicates repeated flag resolves", () => {
  const values = new ValueTable();
  const first = values.addActionOutput(fitsUnsigned(1));
  const second = values.addActionOutput(fitsUnsigned(1));
  const block = {
    body: {
      actions: [
        resolveFlag(first, "ZF"),
        resolveFlag(second, "ZF"),
        stateWrite(gprChannel("eax"), first),
        stateWrite(gprChannel("ebx"), second)
      ]
    },
    values
  } as const;

  deepStrictEqual(helperCalls(block), [
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});
