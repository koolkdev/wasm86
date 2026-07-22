import {
  deepStrictEqual,
  strictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import {
  resourceRef,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { resourceRead } from "#compiler/ir/operations/resource.js";
import { compileProgram } from "#compiler/program/compile.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  functionExportRef,
  functionRef
} from "#compiler/program/refs.js";
import {
  createProgramResources,
  type ProgramResources
} from "#compiler/program/resources.js";

const fixture = createTestResources();
const readType = functionType([], ["i32"]);

test("compiled programs preserve reachable memories, exact exports, and runnable bytes", async () => {
  const program = new ProgramBuilder(fixture.resources);
  const access = memoryRead(fixture.used);
  const read = program.defineFunction({
    ref: functionRef("test.compile.read"),
    type: readType,
    effects: { reads: [access], writes: [] }
  }, (fn) => {
    const value = fn.region.operation(resourceRead, {
      source: memoryOperand(fixture.used, access, fn.values.const(0))
    });

    fn.return([value]);
  });
  const exportRef = functionExportRef("test.compile.read-export");

  program.exportFunction({ ref: exportRef, name: "read", target: read.ref });
  const compiled = compileProgram(program.finish());

  deepStrictEqual(
    Object.keys(compiled).sort(),
    ["bytes", "functionExports", "functionImports", "memoryImports"]
  );
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

test("program closure rejects a resource absent from its program resources", () => {
  const foreign = createTestResources();
  const program = new ProgramBuilder(fixture.resources);
  const access = memoryRead(foreign.used);

  program.defineFunction({
    ref: functionRef("test.compile.foreign-read"),
    type: readType,
    effects: { reads: [access], writes: [] }
  }, (fn) => {
    const value = fn.region.operation(resourceRead, {
      source: memoryOperand(foreign.used, access, fn.values.const(0))
    });

    fn.return([value]);
  });

  throws(
    () => program.finish(),
    /unknown program resource test\.compile\.used declared by function test\.compile\.foreign-read/
  );
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
    space: "resource",
    resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 4 }
    }
  };
}

function memoryOperand(
  resource: ResourceRef,
  effect: ResourceEffect,
  base: ValueId
): ResourceByteOperand {
  return {
    effect: { ...effect, resource },
    address: { base, displacement: 0 },
    width: 32
  };
}
