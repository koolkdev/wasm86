import { throws } from "node:assert";
import { test } from "node:test";

import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, i32 } from "#compiler/function/values.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { functionRef, resourceRef } from "#compiler/reference.js";
import { planWasmModule } from "#compiler/wasm/module/plan.js";

const voidType = functionType([], []);
const valueType = functionType([Integer[32]], []);
const noEffects = { reads: [], writes: [] } as const;
const memory = {
  ref: resourceRef("test.module-validation-memory"),
  moduleName: "test",
  name: "memory",
  limits: { minPages: 1 }
} as const;
const effect: ResourceEffect = {
  kind: "resource",
  resource: memory.ref,
  range: { kind: "slice", origin: "resource", byteOffset: 0, byteLength: 4 }
};
const effects = { reads: [], writes: [effect] } as const;
const resources = createProgramResources([memory]);

test("emitted resource operations must be covered by declared effects", () => {
  const program = new ProgramBuilder(resources);

  program.defineFunction(
    {
      ref: functionRef("test.module-validation-resource"),
      type: valueType,
      effects: noEffects
    },
    (fn) => {
      const [value] = fn.parameters;

      fn.region.writeResource(access(), value);
      fn.return([]);
    }
  );

  throws(() => planWasmModule(program.finish()), /undeclared write effect/);
});

test("emitted calls contribute their target effects", () => {
  const program = new ProgramBuilder(resources);
  const imported = program.importFunction({
    ref: functionRef("test.module-validation-import"),
    type: voidType,
    effects,
    moduleName: "test",
    name: "effectful"
  });

  program.defineFunction(
    {
      ref: functionRef("test.module-validation-caller"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      fn.region.call(imported, []);
      fn.return([]);
    }
  );

  throws(
    () => planWasmModule(program.finish()),
    /module-validation-caller.*undeclared write effect/
  );
});

test("returned calls contribute their target effects", () => {
  const program = new ProgramBuilder(resources);
  const callee = program.defineFunction(
    {
      ref: functionRef("test.module-validation-tail-callee"),
      type: voidType,
      effects
    },
    (fn) => fn.return([])
  );

  program.defineFunction(
    {
      ref: functionRef("test.module-validation-tail-caller"),
      type: voidType,
      effects: noEffects
    },
    (fn) => fn.returnCall(callee, [])
  );

  throws(
    () => planWasmModule(program.finish()),
    /module-validation-tail-caller.*undeclared write effect/
  );
});

function access(): ResourceAccess<32> {
  return {
    effect,
    address: { base: i32(0), displacement: 0 },
    storageWidth: 32,
    valueWidth: 32
  };
}
