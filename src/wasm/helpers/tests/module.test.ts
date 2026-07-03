import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/slots.js";
import { ValueTable, fitsUnsigned } from "#ir/values.js";
import { analyzePlacement } from "#wasm/emit/placement.js";
import { helperCallsForBlock } from "#wasm/helpers/module.js";
import { resolveFlag, stateWrite } from "#ir/tests/storage-op-helpers.js";

test("helperCallsForBlock reports live scheduled flag resolves", () => {
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

  deepStrictEqual(helperCallsForBlock(block, analyzePlacement(block)), [
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});

test("helperCallsForBlock omits dead scheduled flag resolves", () => {
  const values = new ValueTable();
  const zf = values.addActionOutput(fitsUnsigned(1));

  const block = {
    body: { actions: [resolveFlag(zf, "ZF")] },
    values
  } as const;

  deepStrictEqual(helperCallsForBlock(block, analyzePlacement(block)), []);
});

test("helperCallsForBlock deduplicates repeated scheduled flag resolves", () => {
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

  deepStrictEqual(helperCallsForBlock(block, analyzePlacement(block)), [
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});
