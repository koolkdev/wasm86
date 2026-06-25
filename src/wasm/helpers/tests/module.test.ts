import { deepStrictEqual, notStrictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/slots.js";
import { ValueTable } from "#ir/values.js";
import { analyzeBlockValues } from "#wasm/emit/values.js";
import { helperCallsForBlock } from "#wasm/helpers/module.js";

test("helperCallsForBlock reports live helper calls", () => {
  const values = new ValueTable();
  const zf = values.addHelperCall({ kind: "lazyFlag", flag: "ZF" });
  const block = {
    entry: 0,
    regions: [
      {
        id: 0,
        kind: "entry",
        actions: [
          { kind: "writeState", slot: gprChannel("eax"), value: zf },
          { kind: "continue" }
        ]
      }
    ],
    values
  } as const;

  deepStrictEqual(helperCallsForBlock(block, analyzeBlockValues(block)), [
    { kind: "lazyFlag", flag: "ZF" }
  ]);
});

test("helperCallsForBlock omits dead helper calls", () => {
  const values = new ValueTable();

  values.addHelperCall({ kind: "lazyFlag", flag: "ZF" });

  const block = {
    entry: 0,
    regions: [{ id: 0, kind: "entry", actions: [{ kind: "continue" }] }],
    values
  } as const;

  deepStrictEqual(helperCallsForBlock(block, analyzeBlockValues(block)), []);
});

test("helper calls are not interned", () => {
  const values = new ValueTable();
  const first = values.addHelperCall({ kind: "lazyFlag", flag: "ZF" });
  const second = values.addHelperCall({ kind: "lazyFlag", flag: "ZF" });

  notStrictEqual(first, second);
});
