import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { functionType } from "#compiler/function/type.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { functionRef } from "#compiler/reference.js";

const voidType = functionType([], []);
const noEffects = { reads: [], writes: [] } as const;
const emptyResources = createProgramResources([]);

test("a finished program builder rejects later use", () => {
  const program = new ProgramBuilder(emptyResources);

  program.defineFunction(
    {
      ref: functionRef("test.function"),
      type: voidType,
      effects: noEffects
    },
    (fn) => fn.return([])
  );
  program.finish();

  throws(() => program.finish(), /finished program/);
  throws(
    () =>
      program.defineFunction(
        {
          ref: functionRef("test.late-function"),
          type: voidType,
          effects: noEffects
        },
        (fn) => fn.return([])
      ),
    /finished program/
  );
});

test("finishing snapshots declarations without building function bodies", () => {
  const program = new ProgramBuilder(emptyResources);
  let builds = 0;
  const definition = program.defineFunction(
    {
      ref: functionRef("test.snapshot-function"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      builds += 1;
      fn.return([]);
    }
  );

  const source = program.finish();

  strictEqual(builds, 0);
  strictEqual(source.functions.length, 1);
  strictEqual(source.functions[0], definition);
});

test("function imports and definitions share one declaration identity", () => {
  const ref = functionRef("test.function-declaration");
  const program = new ProgramBuilder(emptyResources);

  program.importFunction({
    ref,
    type: voidType,
    effects: noEffects,
    moduleName: "test",
    name: "host"
  });

  throws(
    () =>
      program.defineFunction(
        {
          ref,
          type: voidType,
          effects: noEffects
        },
        (fn) => fn.return([])
      ),
    /duplicate program function.*declaration/
  );
});
