import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { functionType } from "#compiler/ir/function.js";
import { functionRef } from "#compiler/ir/refs.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { createProgramResources } from "#compiler/program/resources.js";

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

test("closing rejects topology changes without poisoning the builder", () => {
  const program = new ProgramBuilder(emptyResources);
  let triesMutation = true;

  const original = program.defineFunction(
    {
      ref: functionRef("test.closing-function"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      if (triesMutation) {
        triesMutation = false;
        program.defineFunction(
          {
            ref: functionRef("test.closing-late-function"),
            type: voidType,
            effects: noEffects
          },
          (late) => late.return([])
        );
      }
      fn.return([]);
    }
  );

  throws(() => program.finish(), /while it is closing/);

  const closed = program.finish();

  strictEqual(closed.functions.length, 1);
  strictEqual(closed.functions[0]?.ref, original.ref);
});

test("function imports and definitions cannot reuse one declaration ref", () => {
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
