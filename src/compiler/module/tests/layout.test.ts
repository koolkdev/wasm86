import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { functionType } from "#compiler/ir/function.js";
import { functionRef } from "#compiler/ir/refs.js";
import { layoutProgram } from "#compiler/module/layout.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { createProgramResources } from "#compiler/program/resources.js";

test("module layout owns type, function, and export ordering", () => {
  const program = new ProgramBuilder(createProgramResources([]));
  const importedType = functionType([], ["i32"]);
  const firstType = functionType([], ["i32"]);
  const secondType = functionType([], ["i32"]);
  const imported = program.importFunction({
    ref: functionRef("test.layout.imported"),
    type: importedType,
    effects: { reads: [], writes: [] },
    moduleName: "test",
    name: "imported"
  });
  const first = program.defineFunction(
    {
      ref: functionRef("test.layout.first"),
      type: firstType,
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      const [result] = fn.region.call(imported, []);

      ok(result !== undefined);
      fn.return([result]);
    }
  );
  const second = program.defineFunction(
    {
      ref: functionRef("test.layout.second"),
      type: secondType,
      effects: { reads: [], writes: [] }
    },
    (fn) => fn.return([fn.values.const(42)])
  );

  program.exportFunction({
    ref: functionExportRef("test.layout.second-export"),
    name: "second",
    target: second.ref
  });
  program.exportFunction({
    ref: functionExportRef("test.layout.first-export"),
    name: "first",
    target: first.ref
  });

  const layout = layoutProgram(program.finish());

  strictEqual(layout.types.length, 1);
  strictEqual(layout.typeIndices.get(importedType), 0);
  strictEqual(layout.typeIndices.get(firstType), 0);
  strictEqual(layout.typeIndices.get(secondType), 0);
  strictEqual(layout.functionIndices.get(imported.ref), 0);
  strictEqual(layout.functionIndices.get(first.ref), 1);
  strictEqual(layout.functionIndices.get(second.ref), 2);
  deepStrictEqual(
    layout.functionExports.map(({ name, functionIndex }) => ({ name, functionIndex })),
    [
      { name: "second", functionIndex: 2 },
      { name: "first", functionIndex: 1 }
    ]
  );
});
