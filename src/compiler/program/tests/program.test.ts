import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionFamily, type FunctionDefinition } from "#compiler/program/functions.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef } from "#compiler/ir/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";
import {
  resourceRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";

const voidType = functionType([], []);
const i32Type = functionType([], ["i32"]);
const noEffects = { reads: [], writes: [] } as const;

const memoryDefinitions = [
  ["test.function-effect-resource", "functionEffectResource", 1],
  ["test.resource-operation-first-dummy", "firstDummy", 1],
  ["test.resource-operation-second-dummy", "secondDummy", 1],
  ["test.resource-operation-target", "target", 2],
  ["test.dead-read-resource", "deadRead", 1]
] as const;
const testMemories = new Map<string, ResourceRef>();
const programResources = createProgramResources(
  memoryDefinitions.map(([id, name, minPages]) => {
    const ref = resourceRef(id);

    testMemories.set(id, ref);
    return { ref, moduleName: "test", name, limits: { minPages } };
  })
);

function createTestProgram(): ProgramBuilder {
  return new ProgramBuilder(programResources);
}

function testMemory(id: string): ResourceRef {
  const memory = testMemories.get(id);

  assert(memory !== undefined, `missing test program memory ${id}`);
  return memory;
}

function byteOperand(
  resource: ResourceRef,
  range: ByteRange,
  base: ValueId,
  displacement: number,
  width: IntegerWidth
): ResourceByteOperand {
  return {
    effect: { space: "resource", resource, range },
    address: { base, displacement },
    width
  };
}

const functionEffectResource = testMemory("test.function-effect-resource");

function functionEffect(region = 0, byteLength = 4): ResourceEffect {
  return {
    space: "resource",
    resource: functionEffectResource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: region * 4, byteLength }
    }
  };
}

function writeFunctionEffect(
  fn: FunctionBuilder,
  value: ValueId,
  region = 0
): void {
  fn.region.operation(resourceWrite, {
    destination: byteOperand(
      functionEffectResource,
      functionEffect(region).range,
      fn.values.const(0),
      region * 4,
      32
    ),
    value
  });
}

test("forward function definitions close after both factories build", () => {
  const program = createTestProgram();
  let buildCount = 0;
  let callee!: FunctionDefinition;

  const caller = program.defineFunction({
    ref: functionRef("test.caller"),
    type: i32Type,
    effects: noEffects
  }, (fn) => {
    buildCount += 1;
    const result = fn.region.call(callee, [])[0];

    assert(result !== undefined, "missing forward callee result");
    fn.return([result]);
  });
  callee = program.defineFunction({
    ref: functionRef("test.callee"),
    type: i32Type,
    effects: noEffects
  }, (fn) => {
    buildCount += 1;
    fn.return([fn.values.const(42)]);
  });
  program.exportFunction({
    ref: functionExportRef("test.entry"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();

  strictEqual(buildCount, 2);
  deepStrictEqual(closed.functionTypes, [i32Type]);
  strictEqual(closed.functions.length, 2);
});

test("defined resource operations retain only their reachable resource", () => {
  const program = createTestProgram();
  const resource = testMemory("test.resource-operation-target");
  const range: ByteRange = {
    basis: { kind: "resource" },
    slice: { byteOffset: 12, byteLength: 2 }
  };
  const byteAccess: ResourceEffect = {
    space: "resource",
    resource,
    range
  };

  const definition = program.defineFunction({
    ref: functionRef("test.resource-operation-function"),
    type: i32Type,
    effects: { reads: [byteAccess], writes: [byteAccess] }
  }, (fn) => {
    const address = fn.values.const(6);

    fn.region.operation(resourceWrite, {
      destination: byteOperand(resource, range, address, 6, 16),
      value: fn.values.const(0x1234)
    });
    const read = fn.region.operation(resourceRead, {
      source: byteOperand(resource, range, address, 6, 16)
    });
    fn.return([read]);
  });
  const closed = program.finish();
  const fn = closed.functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined) {
    throw new Error("missing resource operation function");
  }
  deepStrictEqual(fn.resources, [resource]);
  deepStrictEqual(closed.memoryImports.map((memory) => memory.ref), [resource]);
});

test("program closure omits dead resource reads", () => {
  const program = createTestProgram();
  const readResource = testMemory("test.dead-read-resource");
  const range: ByteRange = {
    basis: { kind: "resource" },
    slice: { byteOffset: 0, byteLength: 1 }
  };
  const byteAccess: ResourceEffect = {
    space: "resource",
    resource: readResource,
    range
  };

  const definition = program.defineFunction({
    ref: functionRef("test.dead-resource-function"),
    type: i32Type,
    effects: { reads: [byteAccess], writes: [] }
  }, (fn) => {
    fn.region.operation(resourceRead, {
      source: byteOperand(readResource, range, fn.values.const(0), 0, 8)
    });
    fn.return([fn.values.const(7)]);
  });

  const fn = program.finish().functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined) {
    throw new Error("missing dead resource function");
  }
  deepStrictEqual(fn.resources, []);
});

test("program closure rejects a live use of an unknown resource", () => {
  const program = createTestProgram();
  const resource = resourceRef("test.unknown-symbolic-resource");
  const byteAccess: ResourceEffect = {
    space: "resource",
    resource,
    range: { basis: { kind: "resource" } }
  };

  program.defineFunction({
    ref: functionRef("test.unknown-symbolic-resource-function"),
    type: i32Type,
    effects: noEffects
  }, (fn) => {
    fn.return([fn.region.operation(resourceRead, {
      source: byteOperand(resource, byteAccess.range, fn.values.const(0), 0, 8)
    })]);
  });

  throws(
    () => program.finish(),
    /unknown program resource test\.unknown-symbolic-resource used by function test\.unknown-symbolic-resource-function/
  );
});

test("function declarations keep resource bindings direct while effects are transitive", () => {
  const program = createTestProgram();
  const type = functionType(["i32"], []);
  const rootRef = functionRef("test.transitive-effects-root");
  const middleRef = functionRef("test.transitive-effects-middle");
  const leafRef = functionRef("test.transitive-effects-leaf");
  const effects = { reads: [], writes: [functionEffect()] } as const;
  let middle!: FunctionDefinition;
  let leaf!: FunctionDefinition;
  const root = program.defineFunction({ ref: rootRef, type, effects }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing root parameter");
    }
    fn.region.call(middle, [value]);
    fn.return([]);
  });
  middle = program.defineFunction({ ref: middleRef, type, effects }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing middle parameter");
    }
    fn.region.call(leaf, [value]);
    fn.return([]);
  });
  leaf = program.defineFunction({ ref: leafRef, type, effects }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing leaf parameter");
    }
    writeFunctionEffect(fn, value);
    fn.return([]);
  });

  const closed = program.finish();
  const functions = closed.functions;

  deepStrictEqual(functions.find((fn) => fn.ref === leaf.ref)?.effects, effects);
  deepStrictEqual(functions.find((fn) => fn.ref === middle.ref)?.effects, effects);
  deepStrictEqual(functions.find((fn) => fn.ref === root.ref)?.effects, effects);
  deepStrictEqual(
    functions.find((fn) => fn.ref === leaf.ref)?.resources,
    [functionEffectResource]
  );
  deepStrictEqual(functions.find((fn) => fn.ref === middle.ref)?.resources, []);
  deepStrictEqual(functions.find((fn) => fn.ref === root.ref)?.resources, []);
});

test("function effect declarations must cover their bodies", () => {
  const program = createTestProgram();
  const type = functionType(["i32"], []);
  program.defineFunction({
    ref: functionRef("test.undeclared-effect"),
    type,
    effects: noEffects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    writeFunctionEffect(fn, value);
    fn.return([]);
  });

  throws(() => program.finish(), /undeclared write effect/);
});

test("callers must cover the effects declared by their call targets", () => {
  const program = createTestProgram();
  const type = functionType(["i32"], []);
  const effects = {
    reads: [],
    writes: [functionEffect()]
  } as const;
  const callee = program.defineFunction({
    ref: functionRef("test.call-effect-callee"),
    type,
    effects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    writeFunctionEffect(fn, value);
    fn.return([]);
  });
  program.defineFunction({
    ref: functionRef("test.call-effect-caller"),
    type,
    effects: noEffects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    fn.region.call(callee, [value]);
    fn.return([]);
  });

  throws(
    () => program.finish(),
    /call-effect-caller.*undeclared write effect/
  );
});

test("calls enforce their declared function contracts", () => {
  const program = createTestProgram();
  const callee = program.defineFunction({
    ref: functionRef("test.argument-callee"),
    type: functionType(["i32"], []),
    effects: noEffects
  }, (fn) => fn.return([]));

  program.defineFunction({
    ref: functionRef("test.argument-caller"),
    type: voidType,
    effects: noEffects
  }, (fn) => {
    fn.region.call(callee, []);
    fn.return([]);
  });

  throws(() => program.finish(), /expects 1 arguments, got 0/);
});

test("functions must terminate with a return matching their result contract", () => {
  const missingReturn = createTestProgram();

  missingReturn.defineFunction({
    ref: functionRef("test.missing-return"),
    type: i32Type,
    effects: noEffects
  }, () => {});

  throws(() => missingReturn.finish(), /root body does not complete/);

  const wrongResultType = createTestProgram();

  wrongResultType.defineFunction({
    ref: functionRef("test.wrong-result-type"),
    type: i32Type,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const64(1n)]));

  throws(() => wrongResultType.finish(), /result 0 must be i32, got i64/);
});

test("successful closure rejects later use", () => {
  const program = createTestProgram();
  program.defineFunction({
    ref: functionRef("test.function"),
    type: voidType,
    effects: noEffects
  }, (body) => body.return([]));

  program.finish();

  throws(() => program.finish(), /finished program/);
  throws(
    () => program.defineFunction({
      ref: functionRef("test.late-function"),
      type: voidType,
      effects: noEffects
    }, (body) => body.return([])),
    /finished program/
  );
});

test("function factories cannot mutate program topology while it is closing", () => {
  const program = createTestProgram();
  let triesMutation = true;

  program.defineFunction({
    ref: functionRef("test.closing-function"),
    type: voidType,
    effects: noEffects
  }, (fn) => {
    if (triesMutation) {
      triesMutation = false;
      program.defineFunction({
        ref: functionRef("test.closing-late-function"),
        type: voidType,
        effects: noEffects
      }, (late) => late.return([]));
    }
    fn.return([]);
  });

  throws(() => program.finish(), /while it is closing/);
  strictEqual(program.finish().functions.length, 1);
});

test("program validation rejects a duplicate function identity", () => {
  const program = createTestProgram();

  for (let index = 0; index < 2; index += 1) {
    program.defineFunction({
      ref: functionRef("same-function"),
      type: voidType,
      effects: noEffects
    }, (fn) => fn.return([]));
  }
  throws(() => program.finish(), /duplicate program function identity/);
});

test("program validation rejects duplicate export names", () => {
  const program = createTestProgram();
  const fn = program.defineFunction({
    ref: functionRef("duplicate-export-name-function"),
    type: voidType,
    effects: noEffects
  }, (body) => body.return([]));

  program.exportFunction({ ref: functionExportRef("first-export"), name: "entry", target: fn.ref });
  program.exportFunction({ ref: functionExportRef("second-export"), name: "entry", target: fn.ref });
  throws(() => program.finish(), /duplicate program export name/);
});

test("program validation resolves export targets by identity", () => {
  const program = createTestProgram();
  const declared = program.defineFunction({
    ref: functionRef("test.declared"),
    type: voidType,
    effects: noEffects
  }, (fn) => fn.return([]));

  program.exportFunction({
    ref: functionExportRef("test.identity-export"),
    name: "entry",
    target: functionRef(declared.ref.id)
  });

  throws(
    () => program.finish(),
    /unknown program function test\.declared exported/
  );
});

test("program closure rejects functions owned by another program", () => {
  const owner = createTestProgram();
  const consumer = createTestProgram();
  const type = functionType([], ["i32"]);
  const owned = owner.defineFunction({
    ref: functionRef("test.owned-function"),
    type,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const(1)]));

  consumer.defineFunction({
    ref: functionRef("test.cross-program-root"),
    type,
    effects: noEffects
  }, (fn) => {
    const result = fn.region.call(owned, [])[0];

    assert(result !== undefined, "missing cross-program result");
    fn.return([result]);
  });

  throws(() => consumer.finish(), /belongs to another program/);
});

test("program closure retains live and transitive family types but omits a dead type", () => {
  const program = createTestProgram();
  const rootType = functionType([], ["i64"]);
  const liveType = functionType([], ["i64"]);
  const transitiveType = functionType([], ["i64"]);
  const deadType = functionType([], []);
  const builds: string[] = [];
  const transitiveFamily = new FunctionFamily<number>({
    type: transitiveType,
    effects: () => noEffects,
    id: (key) => `test.generated.transitive.${key}`,
    build: (key, fn) => {
      builds.push(`transitive-${key}`);
      fn.return([fn.values.const64(BigInt(key))]);
    }
  });
  const transitive = transitiveFamily.get(3);
  const liveFamily = new FunctionFamily<number>({
    type: liveType,
    effects: () => noEffects,
    id: (key) => `test.generated.live.${key}`,
    build: (key, fn) => {
      builds.push(`live-${key}`);
      const result = fn.region.call(transitive, [])[0];

      if (result === undefined) {
        throw new Error("missing transitive generated result");
      }
      fn.return([result]);
    }
  });
  const deadFamily = new FunctionFamily<number>({
    type: deadType,
    effects: () => noEffects,
    id: (key) => `test.generated.dead.${key}`,
    build: (key, fn) => {
      builds.push(`dead-${key}`);
      fn.return([]);
    }
  });
  const live = liveFamily.get(2);
  const dead = deadFamily.get(1);
  const root = program.defineFunction({
    ref: functionRef("test.generated.root"),
    type: rootType,
    effects: noEffects
  }, (fn) => {
    fn.region.call(dead, []);
    const result = fn.region.call(live, [])[0];

    if (result === undefined) {
      throw new Error("missing live generated result");
    }
    fn.return([result]);
  });

  const closed = program.finish();

  deepStrictEqual(
    closed.functions.map((fn) => fn.ref),
    [root.ref, live.ref, transitive.ref]
  );
  deepStrictEqual(builds, ["live-2", "transitive-3"]);
  deepStrictEqual(closed.functionTypes, [rootType, liveType, transitiveType]);
  strictEqual(closed.functionTypes.includes(deadType), false);
  const liveFunction = closed.functions.find((fn) => fn.ref === live.ref);

  assert(liveFunction !== undefined, "missing live family member");
  deepStrictEqual(liveFunction.effects, noEffects);
});

test("generated and declared functions share one identity namespace", () => {
  const program = createTestProgram();
  const type = functionType([], ["i64"]);
  const collisionId = "test.generated-collision";
  let generatedBuilt = false;
  const family = new FunctionFamily<number>({
    type,
    effects: () => noEffects,
    id: () => collisionId,
    build: (_key, fn) => {
      generatedBuilt = true;
      fn.return([fn.values.const64(0n)]);
    }
  });
  const generated = family.get(0);

  program.defineFunction({
    ref: functionRef(collisionId),
    type,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const64(1n)]));
  program.defineFunction({
    ref: functionRef("test.generated-collision-root"),
    type,
    effects: noEffects
  }, (fn) => {
    const result = fn.region.call(generated, [])[0];

    assert(result !== undefined, "missing generated collision result");
    fn.return([result]);
  });

  throws(
    () => program.finish(),
    /duplicate program function identity/
  );
  strictEqual(generatedBuilt, false);
});
