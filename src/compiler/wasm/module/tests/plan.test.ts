import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import type { ResourceAccess, ResourceEffect } from "#compiler/function/resource.js";
import { functionType } from "#compiler/function/type.js";
import { Integer, i32 } from "#compiler/function/values.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { FunctionFamily, type FunctionDefinition } from "#compiler/program/functions.js";
import { createProgramResources } from "#compiler/program/resources.js";
import { functionRef, resourceRef, type ResourceRef } from "#compiler/reference.js";
import { planWasmModule } from "#compiler/wasm/module/plan.js";

const i32Type = functionType([], [Integer[32]]);
const noEffects = { reads: [], writes: [] } as const;
const emptyResources = createProgramResources([]);

test("module planning follows only retained direct calls", () => {
  const program = new ProgramBuilder(emptyResources);
  const liveImport = program.importFunction({
    ref: functionRef("test.plan.live-import"),
    type: i32Type,
    effects: noEffects,
    moduleName: "test",
    name: "live"
  });
  const deadImport = program.importFunction({
    ref: functionRef("test.plan.dead-import"),
    type: i32Type,
    effects: noEffects,
    moduleName: "test",
    name: "dead"
  });
  let builds = 0;
  let callee!: FunctionDefinition<typeof i32Type>;
  const caller = program.defineFunction(
    {
      ref: functionRef("test.plan.caller"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      builds += 1;
      fn.region.call(deadImport, []);
      const [imported] = fn.region.call(liveImport, []);
      const [called] = fn.region.call(callee, []);

      fn.return([imported.add(called)]);
    }
  );
  callee = program.defineFunction(
    {
      ref: functionRef("test.plan.callee"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      builds += 1;
      fn.return([i32(1)]);
    }
  );

  const source = program.finish();

  strictEqual(builds, 0);
  const plan = planWasmModule(source);
  const callerPlan = plan.functions.find((fn) => fn.ref === caller.ref);

  assert(callerPlan !== undefined, "missing planned caller");
  strictEqual(builds, 2);
  deepStrictEqual(callerPlan.plan.dependencies.directCalls, [liveImport, callee]);
  deepStrictEqual(
    plan.functionImports.map((imported) => imported.ref),
    [liveImport.ref]
  );
});

test("module planning retains resources used by emitted operations", () => {
  const liveMemory = memoryImport("test.plan.live-memory", "liveMemory");
  const deadMemory = memoryImport("test.plan.dead-memory", "deadMemory");
  const liveEffect = effect(liveMemory.ref);
  const deadEffect = effect(deadMemory.ref);
  const program = new ProgramBuilder(createProgramResources([deadMemory, liveMemory]));
  const definition = program.defineFunction(
    {
      ref: functionRef("test.plan.resource-function"),
      type: i32Type,
      effects: { reads: [deadEffect], writes: [liveEffect] }
    },
    (fn) => {
      fn.region.readResource(access(deadEffect));
      fn.region.writeResource(access(liveEffect), i32(9));
      fn.return([i32(7)]);
    }
  );

  const plan = planWasmModule(program.finish());
  const planned = plan.functions.find((fn) => fn.ref === definition.ref);

  assert(planned !== undefined, "missing planned resource function");
  deepStrictEqual(planned.plan.dependencies.resources, [liveMemory.ref]);
  deepStrictEqual(plan.memoryImports, [liveMemory]);
});

test("module planning rejects a retained operation on an unknown resource", () => {
  const program = new ProgramBuilder(emptyResources);
  const unknown = resourceRef("test.plan.unknown-memory");
  const unknownEffect = effect(unknown);

  program.defineFunction(
    {
      ref: functionRef("test.plan.unknown-resource-function"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      const value = fn.region.readResource(access(unknownEffect));

      fn.return([value]);
    }
  );

  throws(
    () => planWasmModule(program.finish()),
    /unknown program resource test\.plan\.unknown-memory used by function/
  );
});

test("module planning rejects calls to another program's definitions", () => {
  const foreignProgram = new ProgramBuilder(emptyResources);
  const foreign = foreignProgram.defineFunction(
    {
      ref: functionRef("test.plan.foreign"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => fn.return([i32(1)])
  );
  const program = new ProgramBuilder(emptyResources);

  program.defineFunction(
    {
      ref: functionRef("test.plan.foreign-caller"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      const [value] = fn.region.call(foreign, []);

      fn.return([value]);
    }
  );

  throws(
    () => planWasmModule(program.finish()),
    /function test\.plan\.foreign belongs to another program/
  );
});

test("stable family plans are reused while program definitions are rebuilt", () => {
  let familyBuilds = 0;
  let rootBuilds = 0;
  const family = new FunctionFamily<number, typeof i32Type>({
    type: i32Type,
    effects: () => noEffects,
    id: (key) => `test.plan.family.${key}`,
    build: (key, fn) => {
      familyBuilds += 1;
      fn.return([i32(key)]);
    }
  });
  const member = family.get(7);
  const program = new ProgramBuilder(emptyResources);

  program.defineFunction(
    {
      ref: functionRef("test.plan.family-root"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      rootBuilds += 1;
      const [value] = fn.region.call(member, []);

      fn.return([value]);
    }
  );
  const source = program.finish();

  planWasmModule(source);
  planWasmModule(source);

  strictEqual(familyBuilds, 1);
  strictEqual(rootBuilds, 2);
});

function memoryImport(id: string, name: string) {
  return {
    ref: resourceRef(id),
    moduleName: "test",
    name,
    limits: { minPages: 1 }
  } as const;
}

function effect(resource: ResourceRef): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset: 0, byteLength: 4 }
  };
}

function access(resourceEffect: ResourceEffect): ResourceAccess<32> {
  return {
    effect: resourceEffect,
    address: { base: i32(0), displacement: 0 },
    storageWidth: 32,
    valueWidth: 32
  };
}
