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

test("descriptive branch hints are encoded in function metadata", () => {
  const body = new WasmFunctionBodyEncoder()
    .i32Const(1)
    .ifBlock({ hint: "unlikely" })
    .endBlock()
    .block()
    .i32Const(1)
    .brIf(0, "likely")
    .endBlock()
    .finish();

  deepStrictEqual(
    body.branchHints.map((hint) => hint.value),
    [0, 1]
  );
});
