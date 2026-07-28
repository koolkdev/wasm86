import { throws } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { functionType } from "#compiler/ir/function.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import { resourceRef, type ResourceEffect } from "#compiler/ir/resource.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { FunctionFamily } from "#compiler/program/functions.js";
import { createProgramResources } from "#compiler/program/resources.js";

const voidType = functionType([], []);
const noEffects = { reads: [], writes: [] } as const;
const emptyResources = createProgramResources([]);
const effectMemory = {
  ref: resourceRef("test.effect-memory"),
  moduleName: "test",
  name: "effectMemory",
  limits: { minPages: 1 }
};
const effect: ResourceEffect = {
  space: "resource",
  resource: effectMemory.ref,
  range: {
    basis: { kind: "resource" },
    slice: { byteOffset: 0, byteLength: 4 }
  }
};
const effectResources = createProgramResources([effectMemory]);

test("declared function effects must cover live body operations", () => {
  const program = new ProgramBuilder(effectResources);

  program.defineFunction(
    {
      ref: functionRef("test.undeclared-effect"),
      type: functionType(["i32"], []),
      effects: noEffects
    },
    (fn) => {
      const value = fn.parameters[0];

      assert(value !== undefined, "missing value parameter");
      fn.region.operation(resourceWrite, {
        destination: {
          effect,
          address: { base: fn.values.const(0), displacement: 0 },
          width: 32
        },
        value
      });
      fn.return([]);
    }
  );

  throws(() => program.finish(), /undeclared write effect/);
});

test("function import effects must be declared by callers", () => {
  const program = new ProgramBuilder(effectResources);
  const imported = program.importFunction({
    ref: functionRef("test.effectful-import"),
    type: voidType,
    effects: { reads: [], writes: [effect] },
    moduleName: "test",
    name: "effectfulImport"
  });

  program.defineFunction(
    {
      ref: functionRef("test.effectful-import-caller"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      fn.region.call(imported, []);
      fn.return([]);
    }
  );

  throws(() => program.finish(), /effectful-import-caller.*undeclared write effect/);
});

test("indirect-call effects must be declared by the caller", () => {
  const program = new ProgramBuilder(effectResources);
  const table = tableRef("test.effectful-indirect-table");
  const effects = {
    reads: [],
    writes: [effect]
  } as const;

  program.importTable({
    ref: table,
    moduleName: "test",
    name: "effectfulIndirectTable",
    limits: { minElements: 1 }
  });
  program.defineFunction(
    {
      ref: functionRef("test.undeclared-indirect-effects"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      fn.region.call(
        fn.region.indirectTarget({
          table,
          type: voidType,
          effects,
          elementIndex: fn.values.const(0)
        }),
        []
      );
      fn.return([]);
    }
  );

  throws(() => program.finish(), /undeclared-indirect-effects.*undeclared write effect/);
});

test("return-call effects must be declared by the caller", () => {
  const program = new ProgramBuilder(effectResources);
  const effects = {
    reads: [],
    writes: [effect]
  } as const;
  const callee = program.defineFunction(
    {
      ref: functionRef("test.return-call-effect-callee"),
      type: voidType,
      effects
    },
    (fn) => fn.return([])
  );

  program.defineFunction(
    {
      ref: functionRef("test.return-call-effect-caller"),
      type: voidType,
      effects: noEffects
    },
    (fn) => fn.returnCall(callee, [])
  );

  throws(() => program.finish(), /return-call-effect-caller.*undeclared write effect/);
});

test("live indirect calls require a declared table", () => {
  const program = new ProgramBuilder(emptyResources);
  const table = tableRef("test.unknown-indirect-table");

  program.defineFunction(
    {
      ref: functionRef("test.unknown-indirect-table-function"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      fn.returnCall(
        fn.region.indirectTarget({
          table,
          type: voidType,
          effects: noEffects,
          elementIndex: fn.values.const(0)
        }),
        []
      );
    }
  );

  throws(() => program.finish(), /unknown program table/);
});

test("declared resource effects must reference program resources", () => {
  const resource = resourceRef("test.unknown-effect-resource");
  const program = new ProgramBuilder(emptyResources);

  program.defineFunction(
    {
      ref: functionRef("test.unknown-effect-resource-function"),
      type: voidType,
      effects: {
        reads: [],
        writes: [
          {
            space: "resource",
            resource,
            range: { basis: { kind: "resource" } }
          }
        ]
      }
    },
    (fn) => fn.return([])
  );

  throws(
    () => program.finish(),
    /unknown program resource test\.unknown-effect-resource declared by function test\.unknown-effect-resource-function/
  );
});

test("program function identities must be unique", () => {
  const program = new ProgramBuilder(emptyResources);

  program.defineFunction(
    {
      ref: functionRef("test.same-function"),
      type: voidType,
      effects: noEffects
    },
    (fn) => fn.return([])
  );
  throws(
    () =>
      program.defineFunction(
        {
          ref: functionRef("test.same-function"),
          type: voidType,
          effects: noEffects
        },
        (fn) => fn.return([])
      ),
    /duplicate program function identity/
  );
});

test("program export names must be unique", () => {
  const program = new ProgramBuilder(emptyResources);
  const fn = program.defineFunction(
    {
      ref: functionRef("test.exported-function"),
      type: voidType,
      effects: noEffects
    },
    (body) => body.return([])
  );

  program.exportFunction({
    ref: functionExportRef("test.first-export"),
    name: "entry",
    target: fn.ref
  });
  throws(
    () =>
      program.exportFunction({
        ref: functionExportRef("test.second-export"),
        name: "entry",
        target: fn.ref
      }),
    /duplicate program export name/
  );
});

test("program export targets use reference identity", () => {
  const program = new ProgramBuilder(emptyResources);
  const declared = program.defineFunction(
    {
      ref: functionRef("test.declared"),
      type: voidType,
      effects: noEffects
    },
    (fn) => fn.return([])
  );

  program.exportFunction({
    ref: functionExportRef("test.identity-export"),
    name: "entry",
    target: functionRef(declared.ref.id)
  });

  throws(() => program.finish(), /unknown program function test\.declared exported/);
});

test("function import external names must be unique", () => {
  const program = new ProgramBuilder(emptyResources);

  program.importFunction({
    ref: functionRef("test.first-import"),
    type: voidType,
    effects: noEffects,
    moduleName: "host",
    name: "shared"
  });
  throws(
    () =>
      program.importFunction({
        ref: functionRef("test.second-import"),
        type: voidType,
        effects: noEffects,
        moduleName: "host",
        name: "shared"
      }),
    /duplicate .*external identity: host\.shared/
  );
});

test("memory and function imports share one external-name namespace", () => {
  const program = new ProgramBuilder(effectResources);

  throws(
    () =>
      program.importFunction({
        ref: functionRef("test.cross-kind-import"),
        type: voidType,
        effects: noEffects,
        moduleName: effectMemory.moduleName,
        name: effectMemory.name
      }),
    /duplicate .*external identity: test\.effectMemory/
  );
});

test("generated and declared functions share one identity namespace", () => {
  const program = new ProgramBuilder(emptyResources);
  const type = functionType([], ["i64"]);
  const collisionId = "test.generated-collision";
  const family = new FunctionFamily<number>({
    type,
    effects: () => noEffects,
    id: () => collisionId,
    build: (_key, fn) => fn.return([fn.values.const64(0n)])
  });
  const generated = family.get(0);

  program.defineFunction(
    {
      ref: functionRef(collisionId),
      type,
      effects: noEffects
    },
    (fn) => fn.return([fn.values.const64(1n)])
  );
  program.defineFunction(
    {
      ref: functionRef("test.generated-collision-root"),
      type,
      effects: noEffects
    },
    (fn) => {
      const result = fn.region.call(generated, [])[0];

      assert(result !== undefined, "missing generated collision result");
      fn.return([result]);
    }
  );

  throws(() => program.finish(), /duplicate program function identity/);
});
