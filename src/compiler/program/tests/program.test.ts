import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { encodeWasmModule } from "#compiler/encoder/module.js";
import {
  wasmBodyOpcodes,
  wasmFunctionTypeCount
} from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode, wasmValueType } from "#compiler/encoder/types.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import type { Program } from "#compiler/program/program.js";
import { compileProgram } from "#compiler/compile.js";
import { createModuleBindings } from "#compiler/module/bindings.js";
import { functionType } from "#compiler/ir/function.js";
import { FunctionFamily, type FunctionDefinition } from "#compiler/program/functions.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import { createProgramResources } from "#compiler/program/resources.js";
import {
  validateLinkedProgram
} from "#compiler/program/validate.js";
import {
  DynamicByteOriginRef,
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
import { emitFunction } from "#compiler/emit/function.js";

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

function compileBytes(program: Program): Uint8Array<ArrayBuffer> {
  return compileProgram(program).bytes;
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

function readFunctionEffect(
  fn: FunctionBuilder,
  region = 0,
  width: IntegerWidth = 32
): ValueId {
  return fn.region.operation(resourceRead, {
    source: byteOperand(
      functionEffectResource,
      functionEffect(region, width / 8).range,
      fn.values.const(0),
      region * 4,
      width
    )
  });
}

test("forward function definitions close before their factories build and execute", async () => {
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
  const bytes = compileBytes(closed);
  strictEqual(buildCount, 2);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing compiled program entry");
  }
  strictEqual(entry(), 42);
});

test("symbolic roots close and encode from their function type", async () => {
  const program = createTestProgram();
  const type = functionType([], ["i32"]);
  const calleeRef = functionRef("test.typed-callee");
  const callerRef = functionRef("test.typed-caller");

  const callee = program.defineFunction({
    ref: calleeRef,
    type,
    effects: noEffects
  }, (fn) => {
    fn.return([fn.values.const(42)]);
  });
  const caller = program.defineFunction({
    ref: callerRef,
    type,
    effects: noEffects
  }, (fn) => {
    const result = fn.region.call(callee, [])[0];

    if (result === undefined) {
      throw new Error("missing call result");
    }
    fn.return([result]);
  });
  program.exportFunction({
    ref: functionExportRef("test.typed-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();

  deepStrictEqual(closed.functionTypes, [type]);
  strictEqual(closed.functionTypes[0], type);
  strictEqual(closed.functions.length, 2);
  const bytes = compileBytes(closed);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing program entry");
  }
  strictEqual(entry(), 42);
});

test("program validation enforces the finished program's exact function type list", () => {
  const builder = createTestProgram();
  const firstType = functionType([], []);
  const secondType = functionType([], ["i32"]);

  builder.defineFunction({
    ref: functionRef("test.closed-function-type-validation-first"),
    type: firstType,
    effects: noEffects
  }, (fn) => fn.return([]));
  builder.defineFunction({
    ref: functionRef("test.closed-function-type-validation-second"),
    type: secondType,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const(1)]));
  const closed = builder.finish();
  const extraType = functionType(["i32"], []);

  throws(
    () => validateLinkedProgram({
      ...closed,
      functionTypes: [secondType]
    } as Program),
    /type is missing from the program function types/
  );
  throws(
    () => validateLinkedProgram({
      ...closed,
      functionTypes: [...closed.functionTypes, extraType]
    } as Program),
    /unrequired function type/
  );
  throws(
    () => validateLinkedProgram({
      ...closed,
      functionTypes: [...closed.functionTypes, firstType]
    } as Program),
    /duplicate function type/
  );
  throws(
    () => validateLinkedProgram({
      ...closed,
      functionTypes: [secondType, firstType]
    } as Program),
    /not in required order/
  );
});

test("defined resource operations import only their reachable resource", async () => {
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
  program.exportFunction({
    ref: functionExportRef("test.resource-operation-export"),
    name: "entry",
    target: definition.ref
  });

  const closed = program.finish();
  const fn = closed.functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined) {
    throw new Error("missing resource operation function");
  }
  deepStrictEqual(fn.resources, [resource]);
  deepStrictEqual(closed.memoryImports.map((memory) => memory.ref), [resource]);

  const targetMemory = new WebAssembly.Memory({ initial: 2 });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(compileBytes(closed)),
    {
      test: {
        target: targetMemory
      }
    }
  );
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing resource operation export");
  }
  strictEqual(entry(), 0x1234);
  strictEqual(new DataView(targetMemory.buffer).getUint16(12, true), 0x1234);
});

test("program validation rejects malformed declared resource effects", () => {
  const resource = resourceRef("test.malformed-declared-resource");
  const cases: readonly [ResourceEffect, RegExp][] = [
    [{
      space: "resource",
      resource: { kind: "resource", id: "" } as ResourceRef,
      range: { basis: { kind: "resource" } }
    }, /declared read effect 0 effect has an invalid resource identity/],
    [{
      space: "resource",
      resource,
      range: { basis: undefined } as unknown as ByteRange
    }, /declared write effect 0 range is missing its basis/],
    [{
      space: "resource",
      resource,
      range: {
        basis: {
          kind: "dynamic",
          origin: {} as DynamicByteOriginRef
        }
      }
    }, /declared read effect 0 dynamic basis origin must be a DynamicByteOriginRef/],
    [{
      space: "resource",
      resource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: -1, byteLength: 1 }
      }
    }, /declared write effect 0 slice byte offset must be a non-negative integer/],
    [{
      space: "resource",
      resource,
      range: {
        basis: { kind: "resource" },
        slice: { byteOffset: 0xffff_ffff, byteLength: 2 }
      }
    }, /declared read effect 0 range end must not exceed 2\^32 bytes/]
  ];

  for (const [index, [effect, expected]] of cases.entries()) {
    const program = createTestProgram();

    program.defineFunction({
      ref: functionRef(`test.malformed-effect-function-${index}`),
      type: voidType,
      effects: index % 2 === 0
        ? { reads: [effect], writes: [] }
        : { reads: [], writes: [effect] }
    }, (fn) => fn.return([]));

    throws(() => program.finish(), expected);
  }
});

test("program validation checks retained function type shapes", () => {
  const program = createTestProgram();
  const type = functionType(["f32" as "i32"], []);

  program.defineFunction({
    ref: functionRef("test.invalid-function-type"),
    type,
    effects: noEffects
  }, (fn) => fn.return([]));
  throws(
    () => program.finish(),
    /unknown function value type: f32/
  );
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

test("program validation rejects unknown effects and undeclared live resource uses", () => {
  {
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
  }
  {
    const program = createTestProgram();
    const resource = resourceRef("test.unknown-resource-effect");
    const byteAccess: ResourceEffect = {
      space: "resource",
      resource,
      range: { basis: { kind: "resource" } }
    };

    program.defineFunction({
      ref: functionRef("test.unknown-resource-effect-function"),
      type: i32Type,
      effects: { reads: [byteAccess], writes: [] }
    }, (fn) => fn.return([fn.values.const(1)]));

    throws(
      () => program.finish(),
      /unknown program resource test\.unknown-resource-effect declared by function test\.unknown-resource-effect-function/
    );
  }
});

test("an effectful function call stays single and conditional inside its selected if arm", async () => {
  const program = createTestProgram();
  const calleeType = functionType(["i32"], []);
  const callerType = functionType(["i32"], ["i32"]);
  const calleeRef = functionRef("test.conditional-callee");
  const callerRef = functionRef("test.conditional-caller");
  const effects = {
    reads: [],
    writes: [functionEffect()]
  } as const;
  const callee = program.defineFunction({
    ref: calleeRef,
    type: calleeType,
    effects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    writeFunctionEffect(fn, value);
    fn.return([]);
  });
  const caller = program.defineFunction({
    ref: callerRef,
    type: callerType,
    effects
  }, (fn) => {
    const condition = fn.parameters[0];

    if (condition === undefined) {
      throw new Error("missing condition parameter");
    }
    fn.region.if(condition, (thenBody) => {
      thenBody.call(callee, [fn.values.const(42)]);
    });
    fn.return([fn.values.const(7)]);
  });
  program.exportFunction({
    ref: functionExportRef("test.conditional-caller-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();
  const callerDefinition = closed.functions.find((fn) => fn.ref === caller.ref);

  if (callerDefinition === undefined) {
    throw new Error("missing conditional caller");
  }
  deepStrictEqual(callerDefinition.effects, effects);
  const emitted = emitFunction(callerDefinition.body, {
    bindings: createModuleBindings({
      functions: new Map([[callee.ref, 0]]),
      types: new Map(),
      tables: new Map(),
      resources: new Map()
    }),
    placement: callerDefinition.placement
  });
  const opcodes = wasmBodyOpcodes(emitted.bytes);
  const callCount = opcodes.filter((opcode) => opcode === wasmOpcode.call).length;

  strictEqual(callCount, 1);
  ok(opcodes.indexOf(wasmOpcode.if) < opcodes.indexOf(wasmOpcode.call));

  const calleeBody = new WasmFunctionBodyEncoder()
      .i32Const(0)
      .i32Const(0)
      .i32Load({ align: 2, memoryIndex: 0, offset: 0 })
      .i32Const(1)
      .i32Add()
      .i32Store({ align: 2, memoryIndex: 0, offset: 0 })
      .finish();
  const bytes = encodeWasmModule({
    functionTypes: [
      { params: [wasmValueType.i32], results: [] },
      { params: [wasmValueType.i32], results: [wasmValueType.i32] }
    ],
    functionImports: [],
    memoryImports: [
      { moduleName: "test", name: "state", limits: { minPages: 1 } }
    ],
    tableImports: [],
    functions: [
      { typeIndex: 0, body: calleeBody },
      { typeIndex: 1, body: emitted }
    ],
    globals: [],
    functionExports: [{ name: "entry", functionIndex: 1 }]
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(bytes),
    { test: { state: memory } }
  );
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing conditional program entry");
  }
  strictEqual(entry(0), 7);
  strictEqual(new DataView(memory.buffer).getUint32(0, true), 0);
  strictEqual(entry(1), 7);
  strictEqual(new DataView(memory.buffer).getUint32(0, true), 1);
  strictEqual(entry(1), 7);
  strictEqual(new DataView(memory.buffer).getUint32(0, true), 2);
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

test("resource effect declarations preserve their range basis and extent", () => {
  {
    const program = createTestProgram();
    const type = functionType(["i32"], []);
    program.defineFunction({
      ref: functionRef("test.dynamic-gpr-effect"),
      type,
      effects: {
        reads: [],
        writes: [functionEffect(0, 1)]
      }
    }, (fn) => {
      const value = fn.parameters[0];

      if (value === undefined) {
        throw new Error("missing value parameter");
      }
      writeFunctionEffect(fn, value);
      fn.return([]);
    });

    throws(() => program.finish(), /undeclared write effect/);
  }
  {
    const program = createTestProgram();
    const type = functionType([], ["i32"]);

    const origin = new DynamicByteOriginRef();
    program.defineFunction({
      ref: functionRef("test.dynamic-segment-effect"),
      type,
      effects: {
        reads: [{
          space: "resource",
          resource: functionEffectResource,
          range: {
            basis: { kind: "dynamic", origin },
            slice: { byteOffset: 0, byteLength: 2 }
          }
        }],
        writes: []
      }
    }, (fn) => {
      const selector = readFunctionEffect(fn, 0, 16);

      fn.return([selector]);
    });

    throws(() => program.finish(), /undeclared read effect/);
  }
});

test("calls enforce their declared function contracts", () => {
  {
    const program = createTestProgram();
    const calleeType = functionType(["i32"], []);
    const callerType = functionType([], []);
    const calleeRef = functionRef("test.argument-callee");
    const callerRef = functionRef("test.argument-caller");

    const callee = program.defineFunction({
      ref: calleeRef,
      type: calleeType,
      effects: noEffects
    }, (fn) => {
      fn.return([]);
    });
    program.defineFunction({
      ref: callerRef,
      type: callerType,
      effects: noEffects
    }, (fn) => {
      fn.region.call(callee, []);
      fn.return([]);
    });

    throws(() => program.finish(), /expects 1 arguments, got 0/);
  }
});

test("functions must terminate with a return matching their result contract", () => {
  const missingReturn = createTestProgram();

  missingReturn.defineFunction({
    ref: functionRef("test.missing-return"),
    type: i32Type,
    effects: noEffects
  }, () => {});

  throws(() => missingReturn.finish(), /root body does not complete/);

  const missingResult = createTestProgram();

  missingResult.defineFunction({
    ref: functionRef("test.missing-result"),
    type: i32Type,
    effects: noEffects
  }, (fn) => fn.return([]));

  throws(() => missingResult.finish(), /returns 0 values, expected 1/);

  const wrongResultType = createTestProgram();

  wrongResultType.defineFunction({
    ref: functionRef("test.wrong-result-type"),
    type: i32Type,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const64(1n)]));

  throws(() => wrongResultType.finish(), /result 0 must be i32, got i64/);

  const unexpectedResult = createTestProgram();

  unexpectedResult.defineFunction({
    ref: functionRef("test.unexpected-result"),
    type: voidType,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const(1)]));

  throws(() => unexpectedResult.finish(), /returns 1 values, expected 0/);
});

test("successful closure rejects every later topology mutation", () => {
  const program = createTestProgram();
  const fn = program.defineFunction({
    ref: functionRef("test.function"),
    type: voidType,
    effects: noEffects
  }, (body) => body.return([]));

  program.finish();

  throws(() => program.finish(), /finished program/);
  throws(
    () => program.importTable({
      ref: tableRef("test.late-table"),
      moduleName: "test",
      name: "table",
      limits: { minElements: 1 }
    }),
    /finished program/
  );
  throws(
    () => program.defineFunction({
      ref: functionRef("test.late-function"),
      type: voidType,
      effects: noEffects
    }, (body) => body.return([])),
    /finished program/
  );
  throws(
    () => program.exportFunction({
      ref: functionExportRef("test.late-export"),
      name: "late",
      target: fn.ref
    }),
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

test("closed functions do not retain their mutable factory builders", () => {
  const program = createTestProgram();
  let rawBuilder!: FunctionBuilder;

  const definition = program.defineFunction({
    ref: functionRef("test.function-snapshot"),
    type: voidType,
    effects: noEffects
  }, (fn) => {
    rawBuilder = fn;
    fn.return([]);
  });
  const closed = program.finish();
  const fn = closed.functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined) {
    throw new Error("missing snapshotted function");
  }
  const valueCount = fn.body.values.size();

  rawBuilder.region.return([]);
  rawBuilder.values.const(0x1234_5678);
  strictEqual(fn.body.body.nodes.length, 1);
  strictEqual(fn.body.values.size(), valueCount);
  compileBytes(closed);
});

test("program validation rejects duplicate stable declaration identities", () => {
  {
    const program = createTestProgram();

    program.importTable({
      ref: tableRef("same-table"),
      moduleName: "test",
      name: "first",
      limits: { minElements: 1 }
    });
    program.importTable({
      ref: tableRef("same-table"),
      moduleName: "test",
      name: "second",
      limits: { minElements: 1 }
    });
    throws(() => program.finish(), /duplicate program table identity/);
  }
  {
    const program = createTestProgram();

    for (let index = 0; index < 2; index += 1) {
      program.defineFunction({
        ref: functionRef("same-function"),
        type: voidType,
        effects: noEffects
      }, (fn) => fn.return([]));
    }
    throws(() => program.finish(), /duplicate program function identity/);
  }
  {
    const program = createTestProgram();
    const fn = program.defineFunction({
      ref: functionRef("same-export-function"),
      type: voidType,
      effects: noEffects
    }, (body) => body.return([]));

    program.exportFunction({ ref: functionExportRef("same-export"), name: "first", target: fn.ref });
    program.exportFunction({ ref: functionExportRef("same-export"), name: "second", target: fn.ref });
    throws(
      () => program.finish(),
      /duplicate program function-export identity/
    );
  }
});

test("program validation rejects duplicate and empty export names", () => {
  {
    const program = createTestProgram();
    const fn = program.defineFunction({
      ref: functionRef("duplicate-export-name-function"),
      type: voidType,
      effects: noEffects
    }, (body) => body.return([]));

    program.exportFunction({ ref: functionExportRef("first-export"), name: "entry", target: fn.ref });
    program.exportFunction({ ref: functionExportRef("second-export"), name: "entry", target: fn.ref });
    throws(() => program.finish(), /duplicate program export name/);
  }
  {
    const program = createTestProgram();
    const fn = program.defineFunction({
      ref: functionRef("empty-export-name-function"),
      type: voidType,
      effects: noEffects
    }, (body) => body.return([]));

    program.exportFunction({ ref: functionExportRef("empty-export"), name: "", target: fn.ref });
    throws(() => program.finish(), /empty program function export name/);
  }
});

test("finished programs snapshot export declarations", () => {
  const program = createTestProgram();
  const fn = program.defineFunction({
    ref: functionRef("test.function"),
    type: voidType,
    effects: noEffects
  }, (body) => body.return([]));
  const exported = {
    ref: functionExportRef("test.export"),
    name: "before",
    target: fn.ref
  };

  program.exportFunction(exported);
  const finished = program.finish();

  exported.name = "after";
  strictEqual(finished.exports[0]?.name, "before");
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
  strictEqual(closed.functions.some((fn) => fn.ref === dead.ref), false);
  deepStrictEqual(builds, ["live-2", "transitive-3"]);
  deepStrictEqual(closed.functionTypes, [rootType, liveType, transitiveType]);
  strictEqual(closed.functionTypes[0], rootType);
  strictEqual(closed.functionTypes[1], liveType);
  strictEqual(closed.functionTypes[2], transitiveType);
  strictEqual(closed.functionTypes.includes(deadType), false);
  const liveFunction = closed.functions.find((fn) => fn.ref === live.ref);

  ok(liveFunction !== undefined, "missing live family member");
  ok(closed.functions.some((fn) => fn.ref === transitive.ref), "missing transitive family member");
  deepStrictEqual(liveFunction.effects, noEffects);
  compileBytes(closed);
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

test("distinct semantic function contracts coalesce to one physical Wasm type", () => {
  const program = createTestProgram();
  const firstType = functionType([], ["i32"]);
  const secondType = functionType([], ["i32"]);

  program.defineFunction({
    ref: functionRef("test.first-physical-function"),
    type: firstType,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const(1)]));
  program.defineFunction({
    ref: functionRef("test.second-physical-function"),
    type: secondType,
    effects: noEffects
  }, (fn) => fn.return([fn.values.const(2)]));

  const closed = program.finish();

  deepStrictEqual(closed.functionTypes, [firstType, secondType]);
  strictEqual(closed.functionTypes[0], firstType);
  strictEqual(closed.functionTypes[1], secondType);
  strictEqual(wasmFunctionTypeCount(compileBytes(closed)), 1);
});
