import { throws } from "node:assert";
import { test } from "node:test";

import type { ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { functionRef, resourceRef } from "#compiler/reference.js";

const voidType = functionType([], []);
const noEffects = { reads: [], writes: [] } as const;
const emptyResources = createProgramResources([]);

test("declared resource effects must reference program resources", () => {
  const resource = resourceRef("test.unknown-effect-resource");
  const effect: ResourceEffect = {
    kind: "resource",
    resource,
    range: { kind: "whole", origin: "resource" }
  };
  const program = new ProgramBuilder(emptyResources);

  program.defineFunction(
    {
      ref: functionRef("test.unknown-effect-resource-function"),
      type: voidType,
      effects: { reads: [], writes: [effect] }
    },
    (fn) => fn.return([])
  );

  throws(
    () => program.finish(),
    /unknown program resource test\.unknown-effect-resource declared by function test\.unknown-effect-resource-function/
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

test("memory and function imports share one external-name namespace", () => {
  const memory = {
    ref: resourceRef("test.import-memory"),
    moduleName: "test",
    name: "shared",
    limits: { minPages: 1 }
  };
  const program = new ProgramBuilder(createProgramResources([memory]));

  throws(
    () =>
      program.importFunction({
        ref: functionRef("test.cross-kind-import"),
        type: voidType,
        effects: noEffects,
        moduleName: memory.moduleName,
        name: memory.name
      }),
    /duplicate .*external identity: test\.shared/
  );
});
