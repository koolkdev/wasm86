import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmValueType } from "#compiler/encoder/types.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { allHelpers, helperFunctionType } from "#wasm/helpers/module.js";
import { rmDecodeHelperType } from "#engines/interpreter/decode.js";
import { buildInterpreterProgram } from "#engines/interpreter/program.js";

test("interpreter declarations close every raw dependency before body emission", () => {
  const built = buildInterpreterProgram();
  const { program } = built;
  const runExport = program.exports.find((entry) => entry.name === wasmBlockExportName);

  ok(runExport !== undefined, "missing interpreter run export declaration");
  const run = program.functions.find((fn) => fn.ref === runExport.target);

  ok(run !== undefined, "missing interpreter run function declaration");
  const runSignature = program.signatures.find((signature) => signature.ref === run.signature);

  ok(runSignature !== undefined, "missing interpreter run signature declaration");
  deepStrictEqual(runSignature.type, {
    params: [wasmValueType.i32],
    results: [wasmValueType.i64]
  });

  const cpuState = program.memories.find((memory) => memory.name === wasmImport.cpuStateMemoryName);
  const guestMemory = program.memories.find((memory) => memory.name === wasmImport.guestMemoryName);

  ok(cpuState !== undefined, "missing interpreter CPU-state resource declaration");
  ok(guestMemory !== undefined, "missing interpreter guest-memory resource declaration");
  deepStrictEqual(new Set(run.resources), new Set([cpuState.ref, guestMemory.ref]));
  strictEqual(program.globals.length, 3);
  for (const global of program.globals) {
    strictEqual(global.type, wasmValueType.i32);
    strictEqual(global.mutable, true);
  }
  deepStrictEqual(new Set(run.globals), new Set(program.globals.map((global) => global.ref)));

  const declarationsByRef = new Map(program.functions.map((fn) => [fn.ref, fn]));
  const called = run.calls.map((ref) => {
    const declaration = declarationsByRef.get(ref);

    ok(declaration !== undefined, `missing interpreter callee declaration ${ref.id}`);
    return declaration;
  });
  const rmFunctions = called.filter((fn) => fn.globals.length > 0);
  const helperFunctions = called.filter((fn) => fn.globals.length === 0);

  strictEqual(rmFunctions.length, built.rmDecodeHelpers.length);
  strictEqual(helperFunctions.length, allHelpers().length);
  for (const fn of rmFunctions) {
    deepStrictEqual(new Set(fn.resources), new Set([cpuState.ref, guestMemory.ref]));
    deepStrictEqual(new Set(fn.globals), new Set(program.globals.map((global) => global.ref)));
    deepStrictEqual(program.signatures.find((signature) => signature.ref === fn.signature)?.type, rmDecodeHelperType);
    deepStrictEqual(fn.calls, []);
  }
  for (const fn of helperFunctions) {
    deepStrictEqual(fn.resources, [cpuState.ref]);
    deepStrictEqual(fn.globals, []);
    deepStrictEqual(program.signatures.find((signature) => signature.ref === fn.signature)?.type, helperFunctionType);
    deepStrictEqual(fn.calls, []);
  }

  // Raw handler emission belongs to encodeProgram, after all declarations and
  // their dependency subsets above have closed.
  deepStrictEqual(built.handlers, []);
});
