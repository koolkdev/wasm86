import { deepStrictEqual, ok } from "node:assert";
import { test } from "node:test";

import { cpuStatusFlagResolvers } from "#cpu/state.js";
import { x86StatusFlags } from "#core/flags/definitions.js";
import { statusFlagResolverType } from "#core/flags/lazy/resolvers.js";
import { buildInterpreterProgram } from "#engines/interpreter/program.js";
import { wasmBlockExportName, wasmImport } from "#wasm/abi.js";

let cachedProgram: ReturnType<typeof buildInterpreterProgram> | undefined;

test("interpreter closes as a compiler program with a parameterless run root", () => {
  const program = interpreterProgram();
  const runExport = program.exports.find((entry) => entry.name === wasmBlockExportName);

  ok(runExport !== undefined, "missing interpreter run export declaration");
  const run = program.functions.find((fn) => fn.ref === runExport.target);

  ok(run !== undefined, "missing interpreter run function declaration");
  ok(run.kind === "function", "interpreter run must use compiler IR");
  deepStrictEqual(run.type.parameters, []);
  deepStrictEqual(run.type.results, ["i64"]);

  ok(
    program.functions.every((fn) => fn.kind === "function"),
    "interpreter program must not retain a legacy body"
  );
  deepStrictEqual(
    program.memories.map((memory) => memory.name),
    [wasmImport.cpuStateMemoryName, wasmImport.guestMemoryName]
  );
  deepStrictEqual(program.globals, []);
});

test("interpreter links the zero-argument status-flag resolver family", () => {
  const program = interpreterProgram();
  const expectedResolvers = cpuStatusFlagResolvers.members(x86StatusFlags);

  for (const expected of expectedResolvers) {
    const resolver = program.functions.find((fn) => fn.ref === expected.ref);

    ok(resolver !== undefined, `missing status-flag resolver ${expected.ref.id}`);
    ok(resolver.kind === "function", `status-flag resolver ${expected.ref.id} must use compiler IR`);
    deepStrictEqual(resolver.type, statusFlagResolverType);
    deepStrictEqual(resolver.type.parameters, []);
    deepStrictEqual(resolver.effects, expected.effects);
  }
});

function interpreterProgram(): ReturnType<typeof buildInterpreterProgram> {
  cachedProgram ??= buildInterpreterProgram();
  return cachedProgram;
}
