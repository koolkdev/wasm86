import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";

test("encoded body bytes and branch hints are defensive snapshots", () => {
  const body = new WasmFunctionBodyEncoder()
    .callFunction(3)
    .finish();
  const originalBytes = body.bytes;

  body.bytes.fill(0);
  (body.branchHints as unknown[]).push({ offset: 0, value: 0 });

  deepStrictEqual(body.bytes, originalBytes);
  deepStrictEqual(body.branchHints, []);
});
