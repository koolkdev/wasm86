import { strictEqual } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  exportRef,
  functionRef,
  signatureRef
} from "#compiler/program/refs.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import {
  flatMemoryAccess,
  guestMemoryResource
} from "#memory/flat.js";
import { wasmImport } from "#wasm/abi.js";

test("one flat fragment keeps its fixed capacity when backing memory grows", async () => {
  const builder = new ProgramBuilder();
  const signature = signatureRef("memory.flat-e2e.classify-signature");
  const entry = functionRef("memory.flat-e2e.classify");

  builder.signature({
    ref: signature,
    type: functionType(["i32", "i32"], ["i32"])
  });
  builder.importMemory({
    ref: guestMemoryResource,
    moduleName: wasmImport.namespace,
    name: wasmImport.guestMemoryName,
    limits: { minPages: guestMemoryMinimumPages }
  });
  builder.defineFunction({
    ref: entry,
    signature,
    effects: { reads: [], writes: [] }
  }, (fn) => {
    const start = fn.parameters[0];
    const byteLength = fn.parameters[1];

    assert(start !== undefined, "flat classifier start parameter is missing");
    assert(byteLength !== undefined, "flat classifier length parameter is missing");
    const access = flatMemoryAccess(
      fn.values,
      start,
      byteLength,
      "read"
    );

    fn.return([access.invalid]);
  });
  builder.exportFunction({
    ref: exportRef("memory.flat-e2e.classify-export"),
    name: "classify",
    target: entry
  });

  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeProgram(builder.finish())),
    {
      [wasmImport.namespace]: {
        [wasmImport.guestMemoryName]: memory
      }
    }
  );
  const exported = instance.exports.classify;

  if (typeof exported !== "function") {
    throw new Error("flat classifier export is missing");
  }
  const classify = exported as (start: number, byteLength: number) => number;

  strictEqual(classify(guestMemoryMinimumByteLength - 1, 1), 0);
  strictEqual(classify(guestMemoryMinimumByteLength - 1, 2), 1);
  strictEqual(classify(guestMemoryMinimumByteLength, 1), 1);
  strictEqual(classify(-1, 0), 0);

  memory.grow(1);

  strictEqual(classify(guestMemoryMinimumByteLength, 1), 1);
  strictEqual(classify(guestMemoryMinimumByteLength * 2 - 1, 1), 1);
});
