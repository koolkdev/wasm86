import { deepStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { type ResourceAccess } from "#compiler/function/resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import { resourceRef, type ResourceRef } from "#compiler/reference.js";
import { compileProgram } from "#compiler/compile.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { functionType } from "#compiler/function/type.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/reference.js";
import { createProgramResources, type ProgramResources } from "#compiler/program/resources.js";
import { Integer, i32, nonzero, type I32Value } from "#compiler/function/values.js";

const fixture = createTestResources();
const readType = functionType([], [Integer[32]]);

test("compiled programs preserve reachable memories, exact exports, and runnable bytes", async () => {
  const program = new ProgramBuilder(fixture.resources);
  const access = memoryRead(fixture.used);
  const read = program.defineFunction(
    {
      ref: functionRef("test.compile.read"),
      type: readType,
      effects: { reads: [access], writes: [] }
    },
    (fn) => {
      const value = fn.region.readResource(memoryOperand(fixture.used, access, i32(0)));

      fn.return([value]);
    }
  );
  const exportRef = functionExportRef("test.compile.read-export");

  program.exportFunction({ ref: exportRef, name: "read", target: read.ref });
  const compiled = compileProgram(program.finish());

  strictEqual(compiled.memoryImports.length, 1);
  strictEqual(compiled.memoryImports[0]?.ref, fixture.used);
  deepStrictEqual(compiled.memoryImports[0], {
    ref: fixture.used,
    moduleName: "testProgram",
    name: "used",
    limits: { minPages: 1 }
  });
  strictEqual(compiled.functionExports.length, 1);
  strictEqual(compiled.functionExports[0]?.ref, exportRef);
  strictEqual(compiled.functionExports[0]?.name, "read");
  deepStrictEqual(compiled.functionImports, []);

  const memory = new WebAssembly.Memory({ initial: 1 });

  new DataView(memory.buffer).setUint32(0, 42, true);
  const module = await WebAssembly.compile(compiled.bytes);
  const instance = await WebAssembly.instantiate(module, {
    testProgram: { used: memory }
  });
  const exportedRead = instance.exports.read;

  strictEqual(typeof exportedRead, "function");
  strictEqual((exportedRead as () => number)(), 42);
});

test("ownerless functions with dynamic builds are replanned for each program", () => {
  let current = 1;
  const helper = new FunctionDefinition({
    ref: functionRef("test.compile.dynamic-helper"),
    type: readType,
    effects: { reads: [], writes: [] },
    owner: undefined,
    buildStability: "dynamic",
    build: (fn) => fn.return([i32(current)])
  });
  const compileCurrent = (): number => {
    const program = new ProgramBuilder(createProgramResources([]));
    const entry = program.defineFunction(
      {
        ref: functionRef("test.compile.dynamic-entry"),
        type: readType,
        effects: { reads: [], writes: [] }
      },
      (fn) => {
        const [value] = fn.region.call(helper, []);

        fn.return([value]);
      }
    );

    program.exportFunction({
      ref: functionExportRef("test.compile.dynamic-export"),
      name: "run",
      target: entry.ref
    });
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(compileProgram(program.finish()).bytes)
    );
    const run = instance.exports.run;

    ok(typeof run === "function", "missing dynamic helper export");
    return run();
  };

  strictEqual(compileCurrent(), 1);
  current = 2;
  strictEqual(compileCurrent(), 2);
});

test("late Wasm emission agrees with program dependency analysis on dead producers", () => {
  const memory = {
    ref: resourceRef("test.compile.dead-producer-memory"),
    moduleName: "test",
    name: "deadProducerMemory",
    limits: { minPages: 1 }
  };
  const access = memoryRead(memory.ref);
  const program = new ProgramBuilder(createProgramResources([memory]));
  const deadImport = program.importFunction({
    ref: functionRef("test.compile.dead-producer-import"),
    type: readType,
    effects: { reads: [], writes: [] },
    moduleName: "test",
    name: "deadProducerImport"
  });
  const entry = program.defineFunction(
    {
      ref: functionRef("test.compile.dead-producer-entry"),
      type: readType,
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      fn.region.call(deadImport, []);
      fn.region.readResource(memoryOperand(memory.ref, access, i32(0)));
      fn.return([i32(9)]);
    }
  );

  program.exportFunction({
    ref: functionExportRef("test.compile.dead-producer-export"),
    name: "run",
    target: entry.ref
  });
  const compiled = compileProgram(program.finish());

  deepStrictEqual(compiled.functionImports, []);
  deepStrictEqual(compiled.memoryImports, []);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(compiled.bytes));
  const run = instance.exports.run;

  ok(typeof run === "function", "missing dead-producer export");
  strictEqual(run(), 9);
});

test("defined calls normalize narrow arguments and results at the internal ABI", () => {
  const program = new ProgramBuilder(createProgramResources([]));
  const byteType = functionType([Integer[8]], [Integer[8]]);
  const callee = program.defineFunction(
    {
      ref: functionRef("test.compile.narrow-internal-callee"),
      type: byteType,
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      const [parameter] = fn.parameters;
      const dirtyLogicalByte = parameter.eq(1).unsigned.extend(8).add(255);

      fn.return([dirtyLogicalByte]);
    }
  );
  const entry = program.defineFunction(
    {
      ref: functionRef("test.compile.narrow-internal-entry"),
      type: functionType([Integer[32]], [Integer[32]]),
      effects: { reads: [], writes: [] }
    },
    (fn) => {
      const [source] = fn.parameters;
      const [result] = fn.region.call(callee, [source.truncate(8)]);

      fn.return([result.unsigned.extend(32)]);
    }
  );

  program.exportFunction({
    ref: functionExportRef("test.compile.narrow-internal-export"),
    name: "run",
    target: entry.ref
  });
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(compileProgram(program.finish()).bytes)
  );
  const run = instance.exports.run;

  ok(typeof run === "function", "missing narrow internal ABI export");
  strictEqual(run(0x101), 0);
});

test("compiled returned calls keep deep recursion on a bounded stack", () => {
  const program = new ProgramBuilder(createProgramResources([]));
  const type = functionType([Integer[32]], []);
  const countdown = program.defineFunction(
    {
      ref: functionRef("test.compile.tail-countdown"),
      type,
      effects: { reads: [], writes: [] }
    },
    (fn, self) => {
      const [remaining] = fn.parameters;

      fn.region.if(
        nonzero(remaining),
        (thenBody) => {
          thenBody.returnCall(self, [remaining.sub(1)]);
        },
        {
          elseBuild: (elseBody) => {
            elseBody.return([]);
          }
        }
      );
    }
  );

  program.exportFunction({
    ref: functionExportRef("test.compile.tail-countdown-export"),
    name: "countdown",
    target: countdown.ref
  });
  const instance = new WebAssembly.Instance(
    new WebAssembly.Module(compileProgram(program.finish()).bytes)
  );
  const entry = instance.exports.countdown;

  ok(typeof entry === "function", "missing countdown export");
  strictEqual(entry(100_000), undefined);
});

type TestResources = Readonly<{
  resources: ProgramResources;
  used: ResourceRef;
}>;

function createTestResources(): TestResources {
  const used = resourceRef("test.compile.used");
  const unused = resourceRef("test.compile.unused");

  return {
    resources: createProgramResources([
      {
        ref: used,
        moduleName: "testProgram",
        name: "used",
        limits: { minPages: 1 }
      },
      {
        ref: unused,
        moduleName: "testProgram",
        name: "unused",
        limits: { minPages: 1 }
      }
    ]),
    used
  };
}

function memoryRead(resource: ResourceRef): ResourceEffect {
  return {
    kind: "resource",
    resource,
    range: { kind: "slice", origin: "resource", byteOffset: 0, byteLength: 4 }
  };
}

function memoryOperand(
  resource: ResourceRef,
  effect: ResourceEffect,
  base: I32Value
): ResourceAccess<32> {
  return {
    effect: { ...effect, resource },
    address: { base, displacement: 0 },
    storageWidth: 32,
    valueWidth: 32
  };
}
