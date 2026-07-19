import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmValueType } from "#compiler/encoder/types.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";
import { cpuStatusFlagResolvers } from "#cpu/state.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import { statusFlagResolverType } from "#core/flags/lazy/resolvers.js";
import { rmDecodeFunctionType } from "#engines/interpreter/decode.js";
import { buildInterpreterProgram } from "#engines/interpreter/program.js";

test("interpreter declarations close every decoder and resolver dependency before body emission", () => {
  const built = buildInterpreterProgram();
  const { program } = built;
  const runExport = program.exports.find((entry) => entry.name === wasmBlockExportName);

  ok(runExport !== undefined, "missing interpreter run export declaration");
  const run = program.functions.find((fn) => fn.ref === runExport.target);

  ok(run !== undefined, "missing interpreter run function declaration");
  ok(run.kind === "legacy", "interpreter run function must be a legacy root");
  const runSignature = program.signatures.find((signature) => signature.ref === run.signature);

  ok(runSignature !== undefined, "missing interpreter run signature declaration");
  deepStrictEqual(runSignature.type.parameters, ["i32"]);
  deepStrictEqual(runSignature.type.results, ["i64"]);

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
  const rmFunctions = called.filter((fn) => fn.kind === "legacy");
  const resolverFunctions = called.filter((fn) => fn.kind === "function");
  const expectedResolvers = cpuStatusFlagResolvers.members(x86StatusFlags);
  const expectedResolversByRef = new Map(
    expectedResolvers.map((definition) => [definition.ref, definition])
  );

  strictEqual(rmFunctions.length, built.rmDecodeHelpers.length);
  strictEqual(resolverFunctions.length, x86StatusFlags.length);
  deepStrictEqual(
    new Set(resolverFunctions.map((fn) => fn.ref)),
    new Set(expectedResolvers.map((definition) => definition.ref))
  );
  for (const fn of rmFunctions) {
    deepStrictEqual(new Set(fn.resources), new Set([cpuState.ref, guestMemory.ref]));
    deepStrictEqual(new Set(fn.globals), new Set(program.globals.map((global) => global.ref)));
    strictEqual(
      program.signatures.find((signature) => signature.ref === fn.signature)?.type,
      rmDecodeFunctionType
    );
    deepStrictEqual(fn.calls, []);
  }
  for (const fn of resolverFunctions) {
    const expected = expectedResolversByRef.get(fn.ref);

    ok(expected !== undefined, `unexpected status-flag resolver ${fn.ref.id}`);
    strictEqual(
      program.signatures.find((signature) => signature.ref === fn.signature)?.type,
      statusFlagResolverType
    );
    deepStrictEqual(fn.effects, expected.effects);
    deepStrictEqual(fn.callTargets, []);
  }

  // Raw handler emission belongs to encodeProgram, after all declarations and
  // their dependency subsets above have closed.
  deepStrictEqual(built.handlers, []);
});
