import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { WasmModuleEncoder } from "#compiler/encoder/module.js";
import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode, wasmValueType } from "#compiler/encoder/types.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import { FunctionFamily, type FunctionDefinition } from "#compiler/program/functions.js";
import {
  exportRef,
  functionRef,
  globalRef,
  signatureRef,
  tableRef
} from "#compiler/program/refs.js";
import {
  validateProgram
} from "#compiler/program/validate.js";
import {
  DynamicByteOriginRef,
  resourceRef,
  type ByteRange,
  type ResourceByteOperand,
  type ResourceEffect,
  type ResourceRef
} from "#compiler/ir/resource.js";
import { buildIrBlock } from "#ir/region-builder.js";
import type { FunctionBuilder } from "#ir/function.js";
import { stateRead, stateWrite } from "#compiler/ir/operations/state.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import { gprChannel, segmentSelectorChannel } from "#ir/slots.js";
import { valueId } from "#compiler/ir/values/id.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import { emitFunction } from "#wasm/emit/action.js";

const voidType = functionType([], []);
const i32Type = functionType([], ["i32"]);
const noEffects = { reads: [], writes: [] } as const;

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

test("forward function declarations close before their factories build and execute", async () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.i32");
  const caller = functionRef("test.caller");
  const callee = functionRef("test.callee");
  let buildCount = 0;

  program.signature({ ref: signature, type: i32Type });
  program.legacyFunction({
    ref: caller,
    signature,
    calls: [callee],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: (bindings) => {
      buildCount += 1;
      const calleeIndex = bindings.functions.get(callee);

      if (calleeIndex === undefined) {
        throw new Error("missing forward callee binding");
      }
      return new WasmFunctionBodyEncoder().callFunction(calleeIndex).finish();
    }
  });
  program.legacyFunction({
    ref: callee,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => {
      buildCount += 1;
      return new WasmFunctionBodyEncoder().i32Const(42).finish();
    }
  });
  program.exportFunction({ ref: exportRef("test.entry"), name: "entry", target: caller });

  const closed = program.finish();

  validateProgram(closed);
  strictEqual(buildCount, 0);
  const bytes = encodeProgram(closed);
  strictEqual(buildCount, 2);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing compiled program entry");
  }
  strictEqual(entry(), 42);
});

test("functions call typed peers and execute through program encoding", async () => {
  const program = new ProgramBuilder();
  const type = functionType([], ["i32"]);
  const signature = signatureRef("test.typed-signature");
  const calleeRef = functionRef("test.typed-callee");
  const callerRef = functionRef("test.typed-caller");

  program.signature({ ref: signature, type });
  const callee = program.defineFunction({
    ref: calleeRef,
    signature,
    effects: noEffects
  }, (fn) => {
    fn.return([fn.values.const(42)]);
  });
  const caller = program.defineFunction({
    ref: callerRef,
    signature,
    effects: noEffects
  }, (fn) => {
    const result = fn.region.call(callee, [])[0];

    if (result === undefined) {
      throw new Error("missing call result");
    }
    fn.return([result]);
  });
  program.exportFunction({
    ref: exportRef("test.typed-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();

  strictEqual(closed.functions.length, 2);
  ok(closed.functions.every((fn) => fn.kind === "function"));
  const bytes = encodeProgram(closed);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));
  const entry = instance.exports.entry;

  if (typeof entry !== "function") {
    throw new Error("missing program entry");
  }
  strictEqual(entry(), 42);
});

test("defined resource operations resolve memory index two", async () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.resource-operation-signature");
  const firstDummy = resourceRef("test.resource-operation-first-dummy");
  const secondDummy = resourceRef("test.resource-operation-second-dummy");
  const resource = resourceRef("test.resource-operation-target");
  const range: ByteRange = {
    basis: { kind: "resource" },
    slice: { byteOffset: 12, byteLength: 2 }
  };
  const byteAccess: ResourceEffect = {
    space: "resource",
    resource,
    range
  };

  program.signature({ ref: signature, type: i32Type });
  program.importMemory({
    ref: firstDummy,
    moduleName: "test",
    name: "firstDummy",
    limits: { minPages: 1 }
  });
  program.importMemory({
    ref: secondDummy,
    moduleName: "test",
    name: "secondDummy",
    limits: { minPages: 1 }
  });
  program.importMemory({
    ref: resource,
    moduleName: "test",
    name: "target",
    limits: { minPages: 2 }
  });
  const definition = program.defineFunction({
    ref: functionRef("test.resource-operation-function"),
    signature,
    effects: { reads: [byteAccess], writes: [byteAccess] }
  }, (fn) => {
    const address = fn.values.const(6);

    fn.region.operation(resourceWrite.create({
      destination: byteOperand(resource, range, address, 6, 16),
      value: fn.values.const(0x1234)
    }));
    const read = fn.region.operation(resourceRead.create({
      source: byteOperand(resource, range, address, 6, 16)
    }));
    fn.return([read]);
  });
  program.exportFunction({
    ref: exportRef("test.resource-operation-export"),
    name: "entry",
    target: definition.ref
  });

  const closed = program.finish();
  const fn = closed.functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined || fn.kind !== "function") {
    throw new Error("missing resource operation function");
  }
  deepStrictEqual(fn.resources, [resource]);

  const firstDummyMemory = new WebAssembly.Memory({ initial: 1 });
  const secondDummyMemory = new WebAssembly.Memory({ initial: 1 });
  const targetMemory = new WebAssembly.Memory({ initial: 2 });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeProgram(closed)),
    {
      test: {
        firstDummy: firstDummyMemory,
        secondDummy: secondDummyMemory,
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
  strictEqual(new DataView(firstDummyMemory.buffer).getUint16(12, true), 0);
  strictEqual(new DataView(secondDummyMemory.buffer).getUint16(12, true), 0);
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
    const program = new ProgramBuilder();
    const signature = signatureRef(`test.malformed-effect-signature-${index}`);

    program.signature({ ref: signature, type: voidType });
    program.defineFunction({
      ref: functionRef(`test.malformed-effect-function-${index}`),
      signature,
      effects: index % 2 === 0
        ? { reads: [effect], writes: [] }
        : { reads: [], writes: [effect] }
    }, (fn) => fn.return([]));

    throws(() => validateProgram(program.finish()), expected);
  }
});

test("program validation checks retained function and legacy effect shapes", () => {
  {
    const program = new ProgramBuilder();

    program.signature({
      ref: signatureRef("test.invalid-function-type"),
      type: functionType(["f32" as "i32"], [])
    });
    throws(
      () => validateProgram(program.finish()),
      /unknown function value type: f32/
    );
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("test.invalid-legacy-effects-signature");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: functionRef("test.invalid-legacy-effects-function"),
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      effects: "sometimes" as "none",
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(
      () => validateProgram(program.finish()),
      /unknown legacy function effects: sometimes/
    );
  }
});

test("program closure omits dead resource reads", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.dead-resource-signature");
  const readResource = resourceRef("test.dead-read-resource");
  const range: ByteRange = {
    basis: { kind: "resource" },
    slice: { byteOffset: 0, byteLength: 1 }
  };
  const byteAccess: ResourceEffect = {
    space: "resource",
    resource: readResource,
    range
  };

  program.signature({ ref: signature, type: i32Type });
  program.importMemory({
    ref: readResource,
    moduleName: "test",
    name: "deadRead",
    limits: { minPages: 1 }
  });
  const definition = program.defineFunction({
    ref: functionRef("test.dead-resource-function"),
    signature,
    effects: { reads: [byteAccess], writes: [] }
  }, (fn) => {
    fn.region.operation(resourceRead.create({
      source: byteOperand(readResource, range, fn.values.const(0), 0, 8)
    }));
    fn.return([fn.values.const(7)]);
  });

  const fn = program.finish().functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined || fn.kind !== "function") {
    throw new Error("missing dead resource function");
  }
  deepStrictEqual(fn.resources, []);
});

test("program validation rejects unknown effects and undeclared live resource uses", () => {
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("test.unknown-symbolic-resource-signature");
    const resource = resourceRef("test.unknown-symbolic-resource");
    const byteAccess: ResourceEffect = {
      space: "resource",
      resource,
      range: { basis: { kind: "resource" } }
    };

    program.signature({ ref: signature, type: i32Type });
    program.defineFunction({
      ref: functionRef("test.unknown-symbolic-resource-function"),
      signature,
      effects: noEffects
    }, (fn) => {
      fn.return([fn.region.operation(resourceRead.create({
        source: byteOperand(resource, byteAccess.range, fn.values.const(0), 0, 8)
      }))]);
    });

    throws(() => validateProgram(program.finish()), /unknown program resource.*used by function/);
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("test.unknown-resource-effect-signature");
    const resource = resourceRef("test.unknown-resource-effect");
    const byteAccess: ResourceEffect = {
      space: "resource",
      resource,
      range: { basis: { kind: "resource" } }
    };

    program.signature({ ref: signature, type: i32Type });
    program.defineFunction({
      ref: functionRef("test.unknown-resource-effect-function"),
      signature,
      effects: { reads: [byteAccess], writes: [] }
    }, (fn) => fn.return([fn.values.const(1)]));

    throws(() => validateProgram(program.finish()), /unknown program resource.*declared by function/);
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("test.undeclared-legacy-resource-signature");
    const resource = resourceRef("test.undeclared-legacy-resource");
    const range: ByteRange = {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 1 }
    };
    const ir = buildIrBlock((body) => {
      body.operation(resourceWrite.create({
        destination: byteOperand(resource, range, body.values.const(0), 0, 8),
        value: body.values.const(1)
      }));
    });

    program.signature({ ref: signature, type: voidType });
    program.importMemory({
      ref: resource,
      moduleName: "test",
      name: "memory",
      limits: { minPages: 1 }
    });
    program.legacyFunction({
      ref: functionRef("test.undeclared-legacy-resource-function"),
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [{ block: ir, allowImplicitEntryFallthrough: true }],
      build: () => new WasmFunctionBodyEncoder().finish()
    });

    throws(
      () => validateProgram(program.finish()),
      /undeclared program resource.*used by legacy function/
    );
  }
});

test("an effectful function call stays single and conditional inside its selected if arm", async () => {
  const program = new ProgramBuilder();
  const calleeType = functionType(["i32"], []);
  const callerType = functionType(["i32"], ["i32"]);
  const calleeSignature = signatureRef("test.conditional-callee-signature");
  const callerSignature = signatureRef("test.conditional-caller-signature");
  const calleeRef = functionRef("test.conditional-callee");
  const callerRef = functionRef("test.conditional-caller");
  const effects = {
    reads: [],
    writes: [{ space: "state", slot: gprChannel("eax") }]
  } as const;

  program.signature({ ref: calleeSignature, type: calleeType });
  program.signature({ ref: callerSignature, type: callerType });
  const callee = program.defineFunction({
    ref: calleeRef,
    signature: calleeSignature,
    effects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    fn.region.operation(stateWrite.create({ slot: gprChannel("eax"), value }));
    fn.return([]);
  });
  const caller = program.defineFunction({
    ref: callerRef,
    signature: callerSignature,
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
    ref: exportRef("test.conditional-caller-export"),
    name: "entry",
    target: caller.ref
  });

  const closed = program.finish();
  const callerDefinition = closed.functions.find((fn) => fn.ref === caller.ref);

  if (callerDefinition === undefined || callerDefinition.kind !== "function") {
    throw new Error("missing conditional caller");
  }
  deepStrictEqual(callerDefinition.effects, effects);
  const functionIndices = new Map([[callee, 0]]);
  const emitted = emitFunction(callerDefinition.body, {
    functionIndices,
    resourceIndices: new Map(),
    placement: callerDefinition.placement
  });
  const opcodes = wasmBodyOpcodes(emitted.bytes);
  const callCount = opcodes.filter((opcode) => opcode === wasmOpcode.call).length;

  strictEqual(callCount, 1);
  ok(opcodes.indexOf(wasmOpcode.if) < opcodes.indexOf(wasmOpcode.call));

  const module = new WasmModuleEncoder();
  const memoryIndex = module.importMemory("test", "state", { minPages: 1 });
  const calleeTypeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: []
  });
  const callerTypeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const calleeIndex = module.addFunction(
    calleeTypeIndex,
    new WasmFunctionBodyEncoder()
      .i32Const(0)
      .i32Const(0)
      .i32Load({ align: 2, memoryIndex, offset: 0 })
      .i32Const(1)
      .i32Add()
      .i32Store({ align: 2, memoryIndex, offset: 0 })
      .finish()
  );

  strictEqual(calleeIndex, 0);
  const callerIndex = module.addFunction(callerTypeIndex, emitted);

  module.exportFunction("entry", callerIndex);
  const memory = new WebAssembly.Memory({ initial: 1 });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(module.encode()),
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

test("function declarations carry conservative transitive effects", () => {
  const program = new ProgramBuilder();
  const type = functionType(["i32"], []);
  const signature = signatureRef("test.transitive-effects-signature");
  const rootRef = functionRef("test.transitive-effects-root");
  const middleRef = functionRef("test.transitive-effects-middle");
  const leafRef = functionRef("test.transitive-effects-leaf");
  const eax = gprChannel("eax");
  const effects = { reads: [], writes: [{ space: "state", slot: eax }] } as const;
  let middle!: FunctionDefinition;
  let leaf!: FunctionDefinition;

  program.signature({ ref: signature, type });
  const root = program.defineFunction({ ref: rootRef, signature, effects }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing root parameter");
    }
    fn.region.call(middle, [value]);
    fn.return([]);
  });
  middle = program.defineFunction({ ref: middleRef, signature, effects }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing middle parameter");
    }
    fn.region.call(leaf, [value]);
    fn.return([]);
  });
  leaf = program.defineFunction({ ref: leafRef, signature, effects }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing leaf parameter");
    }
    fn.region.operation(stateWrite.create({ slot: eax, value }));
    fn.return([]);
  });

  const functions = program.finish().functions.filter((fn) => fn.kind === "function");

  deepStrictEqual(functions.find((fn) => fn.ref === leaf.ref)?.effects, effects);
  deepStrictEqual(functions.find((fn) => fn.ref === middle.ref)?.effects, effects);
  deepStrictEqual(functions.find((fn) => fn.ref === root.ref)?.effects, effects);
});

test("function effect declarations must cover their bodies", () => {
  const program = new ProgramBuilder();
  const type = functionType(["i32"], []);
  const signature = signatureRef("test.undeclared-effect-signature");

  program.signature({ ref: signature, type });
  program.defineFunction({
    ref: functionRef("test.undeclared-effect"),
    signature,
    effects: noEffects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    fn.region.operation(stateWrite.create({ slot: gprChannel("eax"), value }));
    fn.return([]);
  });

  throws(() => validateProgram(program.finish()), /undeclared write effect/);
});

test("callers must cover the effects declared by their call targets", () => {
  const program = new ProgramBuilder();
  const type = functionType(["i32"], []);
  const signature = signatureRef("test.call-effect-signature");
  const effects = {
    reads: [],
    writes: [{ space: "state", slot: gprChannel("eax") }]
  } as const;

  program.signature({ ref: signature, type });
  const callee = program.defineFunction({
    ref: functionRef("test.call-effect-callee"),
    signature,
    effects
  }, (fn) => {
    const value = fn.parameters[0];

    if (value === undefined) {
      throw new Error("missing value parameter");
    }
    fn.region.operation(stateWrite.create({ slot: gprChannel("eax"), value }));
    fn.return([]);
  });
  program.defineFunction({
    ref: functionRef("test.call-effect-caller"),
    signature,
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
    () => validateProgram(program.finish()),
    /call-effect-caller.*undeclared write effect/
  );
});

test("dynamic effect declarations preserve their access width and segment field", () => {
  {
    const program = new ProgramBuilder();
    const type = functionType(["i32"], []);
    const signature = signatureRef("test.dynamic-gpr-effect-signature");

    program.signature({ ref: signature, type });
    program.defineFunction({
      ref: functionRef("test.dynamic-gpr-effect"),
      signature,
      effects: {
        reads: [],
        writes: [{
          space: "state",
          slot: { kind: "gprDynamic", index: valueId(0), byteLength: 1 }
        }]
      }
    }, (fn) => {
      const value = fn.parameters[0];

      if (value === undefined) {
        throw new Error("missing value parameter");
      }
      fn.region.operation(stateWrite.create({ slot: gprChannel("eax"), value }));
      fn.return([]);
    });

    throws(() => validateProgram(program.finish()), /undeclared write effect/);
  }
  {
    const program = new ProgramBuilder();
    const type = functionType([], ["i32"]);
    const signature = signatureRef("test.dynamic-segment-effect-signature");

    program.signature({ ref: signature, type });
    program.defineFunction({
      ref: functionRef("test.dynamic-segment-effect"),
      signature,
      effects: {
        reads: [{
          space: "state",
          slot: { kind: "segmentDynamic", index: valueId(0), field: "base" }
        }],
        writes: []
      }
    }, (fn) => {
      const selector = fn.region.operation(stateRead.create({ slot: segmentSelectorChannel("ds") }));

      fn.return([selector]);
    });

    throws(() => validateProgram(program.finish()), /undeclared read effect/);
  }
});

test("calls enforce their declared function contracts", () => {
  {
    const program = new ProgramBuilder();
    const calleeType = functionType(["i32"], []);
    const callerType = functionType([], []);
    const calleeSignature = signatureRef("test.argument-callee-signature");
    const callerSignature = signatureRef("test.argument-caller-signature");
    const calleeRef = functionRef("test.argument-callee");
    const callerRef = functionRef("test.argument-caller");

    program.signature({ ref: calleeSignature, type: calleeType });
    program.signature({ ref: callerSignature, type: callerType });
    const callee = program.defineFunction({
      ref: calleeRef,
      signature: calleeSignature,
      effects: noEffects
    }, (fn) => {
      fn.return([]);
    });
    program.defineFunction({
      ref: callerRef,
      signature: callerSignature,
      effects: noEffects
    }, (fn) => {
      fn.region.call(callee, []);
      fn.return([]);
    });

    throws(() => program.finish(), /expects 1 arguments, got 0/);
  }
});

test("functions must terminate with a return matching their result contract", () => {
  const program = new ProgramBuilder();
  const type = functionType([], ["i32"]);
  const signature = signatureRef("test.missing-return-signature");
  const fn = functionRef("test.missing-return");

  program.signature({ ref: signature, type });
  program.defineFunction({ ref: fn, signature, effects: noEffects }, () => {});

  throws(() => program.finish(), /root body does not complete/);
});

test("legacy factories default to conservative behavior and never become eliminable", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  program.signature({ ref: signature, type: voidType });
  program.legacyFunction({
    ref: functionRef("test.function"),
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  program.legacyFunction({
    ref: functionRef("test.reviewed"),
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    effects: "none",
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  const [defaults, reviewed] = program.finish().functions;

  if (defaults === undefined || reviewed === undefined) {
    throw new Error("missing normalized legacy functions");
  }

  strictEqual(defaults.kind, "legacy");
  strictEqual(reviewed.kind, "legacy");
  strictEqual(defaults.effects, "world");
  strictEqual(defaults.eliminable, false);
  strictEqual(reviewed.effects, "none");
  strictEqual(reviewed.eliminable, false);
});

test("successful closure rejects every later topology mutation including one from a body factory", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const fn = functionRef("test.function");

  program.signature({ ref: signature, type: voidType });
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => {
      program.importMemory({
        ref: resourceRef("test.body-late"),
        moduleName: "test",
        name: "late",
        limits: { minPages: 1 }
      });
      return new WasmFunctionBodyEncoder().finish();
    }
  });
  const closed = program.finish();

  throws(() => program.finish(), /finished program/);
  throws(
    () => program.signature({ ref: signatureRef("test.late-signature"), type: voidType }),
    /finished program/
  );
  throws(
    () => program.importMemory({
      ref: resourceRef("test.late-memory"),
      moduleName: "test",
      name: "memory",
      limits: { minPages: 1 }
    }),
    /finished program/
  );
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
    () => program.global({
      ref: globalRef("test.late-global"),
      type: wasmValueType.i32,
      mutable: true,
      initialValue: 0
    }),
    /finished program/
  );
  throws(
    () => program.legacyFunction({
      ref: functionRef("test.late-function"),
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    }),
    /finished program/
  );
  throws(
    () => program.exportFunction({ ref: exportRef("test.late-export"), name: "late", target: fn }),
    /finished program/
  );
  throws(() => encodeProgram(closed), /finished program/);
});

test("function factories cannot mutate program topology while it is closing", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.closing-signature");
  let triesMutation = true;

  program.signature({ ref: signature, type: voidType });
  program.defineFunction({
    ref: functionRef("test.closing-function"),
    signature,
    effects: noEffects
  }, (fn) => {
    if (triesMutation) {
      triesMutation = false;
      program.defineFunction({
        ref: functionRef("test.closing-late-function"),
        signature,
        effects: noEffects
      }, (late) => late.return([]));
    }
    fn.return([]);
  });

  throws(() => program.finish(), /while it is closing/);
  strictEqual(program.finish().functions.length, 1);
});

test("closed functions do not retain their mutable factory builders", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.function-snapshot-signature");
  let rawBuilder!: FunctionBuilder;

  program.signature({ ref: signature, type: voidType });
  const definition = program.defineFunction({
    ref: functionRef("test.function-snapshot"),
    signature,
    effects: noEffects
  }, (fn) => {
    rawBuilder = fn;
    fn.return([]);
  });
  const closed = program.finish();
  const fn = closed.functions.find((candidate) => candidate.ref === definition.ref);

  if (fn === undefined || fn.kind !== "function") {
    throw new Error("missing snapshotted function");
  }
  const valueCount = fn.body.values.size();

  rawBuilder.region.return([]);
  rawBuilder.values.const(0x1234_5678);
  strictEqual(fn.body.body.actions.length, 1);
  strictEqual(fn.body.values.size(), valueCount);
  encodeProgram(closed);
});

test("declaration construction rejects conflicts needed to build a program", () => {
  {
    const program = new ProgramBuilder();

    program.signature({ ref: signatureRef("same-type-signature-a"), type: voidType });
    throws(
      () => program.signature({ ref: signatureRef("same-type-signature-b"), type: voidType }),
      /function type already has a program signature/
    );
  }
  {
    const program = new ProgramBuilder();

    program.signature({ ref: signatureRef("same-signature"), type: voidType });
    throws(
      () => program.defineFunction({
        ref: functionRef("same-id-signature-lookalike-user"),
        signature: signatureRef("same-signature"),
        effects: noEffects
      }, (fn) => fn.return([])),
      /unknown program signature/
    );
  }
  {
    const program = new ProgramBuilder();

    program.importMemory({
      ref: resourceRef("memory-import-a"),
      moduleName: "test",
      name: "memory",
      limits: { minPages: 1 }
    });
    throws(
      () => program.importMemory({
        ref: resourceRef("memory-import-b"),
        moduleName: "test",
        name: "memory",
        limits: { minPages: 1 }
      }),
      /duplicate program memory import: test\.memory/
    );
  }
});

test("program validation rejects duplicate stable declaration identities", () => {
  {
    const program = new ProgramBuilder();

    program.signature({ ref: signatureRef("same-signature"), type: functionType([], []) });
    program.signature({ ref: signatureRef("same-signature"), type: functionType([], []) });
    throws(() => validateProgram(program.finish()), /duplicate program signature identity/);
  }
  {
    const program = new ProgramBuilder();

    program.importMemory({
      ref: resourceRef("same-memory"),
      moduleName: "test",
      name: "first",
      limits: { minPages: 1 }
    });
    program.importMemory({
      ref: resourceRef("same-memory"),
      moduleName: "test",
      name: "second",
      limits: { minPages: 1 }
    });
    throws(() => validateProgram(program.finish()), /duplicate program resource identity/);
  }
  {
    const program = new ProgramBuilder();

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
    throws(() => validateProgram(program.finish()), /duplicate program table identity/);
  }
  {
    const program = new ProgramBuilder();

    program.global({
      ref: globalRef("same-global"),
      type: wasmValueType.i32,
      mutable: true,
      initialValue: 0
    });
    program.global({
      ref: globalRef("same-global"),
      type: wasmValueType.i32,
      mutable: true,
      initialValue: 1
    });
    throws(() => validateProgram(program.finish()), /duplicate program global identity/);
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("same-function-signature");

    program.signature({ ref: signature, type: voidType });
    for (let index = 0; index < 2; index += 1) {
      program.legacyFunction({
        ref: functionRef("same-function"),
        signature,
        calls: [],
        resources: [],
        globals: [],
        tables: [],
        irBlocks: [],
        build: () => new WasmFunctionBodyEncoder().finish()
      });
    }
    throws(() => validateProgram(program.finish()), /duplicate program function identity/);
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("mixed-function-signature");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: functionRef("mixed-function"),
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    program.defineFunction({
      ref: functionRef("mixed-function"),
      signature,
      effects: noEffects
    }, (fn) => fn.return([]));
    throws(() => validateProgram(program.finish()), /duplicate program function identity/);
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("same-export-signature");
    const fn = functionRef("same-export-function");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    program.exportFunction({ ref: exportRef("same-export"), name: "first", target: fn });
    program.exportFunction({ ref: exportRef("same-export"), name: "second", target: fn });
    throws(() => validateProgram(program.finish()), /duplicate program export identity/);
  }
});

test("program validation rejects duplicate and empty export names", () => {
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("duplicate-export-name-signature");
    const fn = functionRef("duplicate-export-name-function");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    program.exportFunction({ ref: exportRef("first-export"), name: "entry", target: fn });
    program.exportFunction({ ref: exportRef("second-export"), name: "entry", target: fn });
    throws(() => program.finish(), /duplicate program export name/);
  }
  {
    const program = new ProgramBuilder();
    const signature = signatureRef("empty-export-name-signature");
    const fn = functionRef("empty-export-name-function");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    program.exportFunction({ ref: exportRef("empty-export"), name: "", target: fn });
    throws(() => validateProgram(program.finish()), /empty program function export name/);
  }
});

test("finished programs snapshot export declarations", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const fn = functionRef("test.function");
  const exported = {
    ref: exportRef("test.export"),
    name: "before",
    target: fn
  };

  program.signature({ ref: signature, type: voidType });
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  program.exportFunction(exported);
  const finished = program.finish();

  exported.name = "after";
  strictEqual(finished.exports[0]?.name, "before");
});

test("program validation resolves references by identity", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const declared = functionRef("test.declared");
  const sameIdLookalike = functionRef("test.declared");
  let built = false;
  let typedBuilt = false;

  program.signature({ ref: signature, type: voidType });
  program.defineFunction({
    ref: functionRef("test.unrelated-typed-function"),
    signature,
    effects: noEffects
  }, (fn) => {
    typedBuilt = true;
    fn.return([]);
  });
  program.legacyFunction({
    ref: declared,
    signature,
    calls: [sameIdLookalike],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => {
      built = true;
      return new WasmFunctionBodyEncoder().finish();
    }
  });

  throws(
    () => validateProgram(program.finish()),
    /unknown program function test\.declared called by function test\.declared/
  );
  strictEqual(built, false);
  strictEqual(typedBuilt, false);
});

test("program validation rejects unknown resources, tables, globals, signatures, and exports", () => {
  const signature = signatureRef("test.signature");

  {
    const program = new ProgramBuilder();
    const fn = functionRef("test.resource-user");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [resourceRef("test.unknown-resource")],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => validateProgram(program.finish()), /unknown program resource/);
  }
  {
    const program = new ProgramBuilder();
    const fn = functionRef("test.table-user");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [tableRef("test.unknown-table")],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => validateProgram(program.finish()), /unknown program table/);
  }
  {
    const program = new ProgramBuilder();
    const fn = functionRef("test.global-user");
    const unknownGlobal = globalRef("test.unknown-global");

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [],
      globals: [unknownGlobal],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => validateProgram(program.finish()), /unknown program global/);
  }
  {
    const program = new ProgramBuilder();
    const unknownSignature = signatureRef("test.unknown-signature");

    program.legacyFunction({
      ref: functionRef("test.unknown-signature-user"),
      signature: unknownSignature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => validateProgram(program.finish()), /unknown program signature/);
  }
  {
    const program = new ProgramBuilder();

    program.exportFunction({
      ref: exportRef("test.export"),
      name: "entry",
      target: functionRef("test.unknown-function")
    });
    throws(() => validateProgram(program.finish()), /unknown program function/);
  }
});

test("recorded direct calls must be declared by that legacy function", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const other = functionRef("test.other");
  const subject = functionRef("test.subject");

  program.signature({ ref: signature, type: voidType });
  program.legacyFunction({
    ref: other,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  program.legacyFunction({
    ref: subject,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().callFunction(0).finish()
  });

  throws(
    () => encodeProgram(program.finish()),
    /undeclared Wasm function index 0/
  );
});

test("recorded memory indexes must come from that legacy function's resources", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const memory = resourceRef("test.memory");
  const fn = functionRef("test.function");

  program.signature({ ref: signature, type: voidType });
  program.importMemory({ ref: memory, moduleName: "test", name: "memory", limits: { minPages: 1 } });
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().memorySize(0).drop().finish()
  });

  throws(
    () => encodeProgram(program.finish()),
    /undeclared Wasm memory index 0/
  );
});

test("recorded table indexes must come from that legacy function's tables", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const table = tableRef("test.table");
  const fn = functionRef("test.function");

  program.signature({ ref: signature, type: voidType });
  program.importTable({ ref: table, moduleName: "test", name: "table", limits: { minElements: 1 } });
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().i32Const(0).callIndirect(0, 0).finish()
  });

  throws(
    () => encodeProgram(program.finish()),
    /undeclared Wasm table index 0/
  );
});

test("recorded type indexes must come from the function's declared signature", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const unrelatedSignature = signatureRef("test.unrelated-signature");
  const table = tableRef("test.table");
  const fn = functionRef("test.function");

  program.signature({ ref: signature, type: voidType });
  program.signature({ ref: unrelatedSignature, type: i32Type });
  program.importTable({ ref: table, moduleName: "test", name: "table", limits: { minElements: 1 } });
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [table],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().i32Const(0).callIndirect(1, 0).finish()
  });

  throws(
    () => encodeProgram(program.finish()),
    /undeclared Wasm type index 1/
  );
});

test("typed internal globals resolve through declared legacy bindings and execute", async () => {
  const program = new ProgramBuilder();
  const counterSignature = signatureRef("test.counter-signature");
  const counter = globalRef("test.counter");
  const increment = functionRef("test.increment");

  program.signature({ ref: counterSignature, type: i32Type });
  program.global({
    ref: counter,
    type: wasmValueType.i32,
    mutable: true,
    initialValue: 40
  });
  program.legacyFunction({
    ref: increment,
    signature: counterSignature,
    calls: [],
    resources: [],
    globals: [counter],
    tables: [],
    irBlocks: [],
    build: (bindings) => {
      const counterIndex = bindings.globals.get(counter);

      if (counterIndex === undefined) {
        throw new Error("missing counter global binding");
      }
      return new WasmFunctionBodyEncoder()
        .globalGet(counterIndex)
        .i32Const(1)
        .i32Add()
        .globalSet(counterIndex)
        .globalGet(counterIndex)
        .finish();
    }
  });
  program.exportFunction({ ref: exportRef("test.increment-export"), name: "increment", target: increment });

  const closed = program.finish();

  const bytes = encodeProgram(closed);
  const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes));
  const incrementExport = instance.exports.increment;

  if (typeof incrementExport !== "function") {
    throw new Error("missing compiled global test exports");
  }
  strictEqual(incrementExport(), 41);
  strictEqual(incrementExport(), 42);
});

test("recorded global indexes must come from that legacy function's globals", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const programGlobal = globalRef("test.global");
  const fn = functionRef("test.function");

  program.signature({ ref: signature, type: voidType });
  program.global({
    ref: programGlobal,
    type: wasmValueType.i32,
    mutable: true,
    initialValue: 0
  });
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().globalGet(0).drop().finish()
  });

  throws(
    () => encodeProgram(program.finish()),
    /undeclared Wasm global index 0/
  );
});

test("program closure rejects functions owned by another program", () => {
  {
    const owner = new ProgramBuilder();
    const consumer = new ProgramBuilder();
    const ownedType = functionType([], []);
    const ownerSignature = signatureRef("test.owner-signature");
    const consumerSignature = signatureRef("test.consumer-signature");
    const ownedRef = functionRef("test.owned-function");
    const root = functionRef("test.cross-program-root");

    owner.signature({ ref: ownerSignature, type: ownedType });
    const owned = owner.defineFunction({
      ref: ownedRef,
      signature: ownerSignature,
      effects: noEffects
    }, (fn) => fn.return([]));
    const ir = buildIrBlock((body) => {
      body.call(owned, []);
    });

    consumer.signature({ ref: consumerSignature, type: voidType });
    consumer.legacyFunction({
      ref: root,
      signature: consumerSignature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      irBlocks: [{ block: ir, allowImplicitEntryFallthrough: true }],
      build: () => new WasmFunctionBodyEncoder().finish()
    });

    throws(() => consumer.finish(), /belongs to another program/);
  }
});

test("program closure includes only function calls that must execute", () => {
  const program = new ProgramBuilder();
  const generatedType = functionType([], ["i64"]);
  const generatedSignature = signatureRef("test.generated-signature");
  const rootSignature = signatureRef("test.generated-root-signature");
  const root = functionRef("test.generated-root");
  const builds: number[] = [];
  let family!: FunctionFamily<number>;

  family = new FunctionFamily<number>({
    type: generatedType,
    effects: () => noEffects,
    id: (key) => `test.generated.${key}`,
    build: (key, fn) => {
      builds.push(key);
      if (key === 2) {
        const result = fn.region.call(family.get(3), [])[0];

        if (result === undefined) {
          throw new Error("missing transitive generated result");
        }
        fn.return([result]);
        return;
      }
      fn.return([fn.values.const64(BigInt(key))]);
    }
  });
  const dead = family.get(1);
  const live = family.get(2);
  const transitive = family.get(3);
  const deadCall = buildIrBlock((body) => {
    body.call(dead, []);
  });
  const liveCall = buildIrBlock((body) => {
    const result = body.call(live, [])[0];

    if (result === undefined) {
      throw new Error("missing live generated result");
    }
    body.finish({ kind: "exit", result });
  });

  program.signature({ ref: rootSignature, type: voidType });
  program.signature({ ref: generatedSignature, type: generatedType });
  program.legacyFunction({
    ref: root,
    signature: rootSignature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [
      { block: deadCall, allowImplicitEntryFallthrough: true },
      { block: liveCall, allowImplicitEntryFallthrough: false }
    ],
    build: () => new WasmFunctionBodyEncoder().finish()
  });

  const closed = program.finish();

  strictEqual(closed.functions.some((fn) => fn.ref === dead.ref), false);
  deepStrictEqual(builds, [2, 3]);
  const liveFunction = closed.functions.find((fn) => fn.ref === live.ref);

  ok(liveFunction?.kind === "function", "missing live family member");
  ok(closed.functions.some((fn) => fn.ref === transitive.ref), "missing transitive family member");
  deepStrictEqual(liveFunction.effects, noEffects);
});

test("generated and declared functions share one identity namespace", () => {
  const program = new ProgramBuilder();
  const generatedType = functionType([], ["i64"]);
  const generatedSignature = signatureRef("test.generated-collision-signature");
  const rootSignature = signatureRef("test.generated-collision-root-signature");
  const collisionId = "test.generated-collision";
  let generatedBuilt = false;
  const family = new FunctionFamily<number>({
    type: generatedType,
    effects: () => noEffects,
    id: () => collisionId,
    build: (_key, fn) => {
      generatedBuilt = true;
      fn.return([fn.values.const64(0n)]);
    }
  });
  const generated = family.get(0);
  const rootBlock = buildIrBlock((body) => {
    const result = body.call(generated, [])[0];

    if (result === undefined) {
      throw new Error("missing generated collision result");
    }
    body.finish({ kind: "exit", result });
  });

  program.signature({ ref: generatedSignature, type: generatedType });
  program.signature({ ref: rootSignature, type: voidType });
  program.legacyFunction({
    ref: functionRef(collisionId),
    signature: generatedSignature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: () => new WasmFunctionBodyEncoder().i64Const(0n).finish()
  });
  program.legacyFunction({
    ref: functionRef("test.generated-collision-root"),
    signature: rootSignature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [{ block: rootBlock, allowImplicitEntryFallthrough: false }],
    build: () => new WasmFunctionBodyEncoder().finish()
  });

  throws(
    () => validateProgram(program.finish()),
    /duplicate program function identity/
  );
  strictEqual(generatedBuilt, false);
});

test("distinct semantic function contracts coalesce to one physical Wasm type", () => {
  const program = new ProgramBuilder();
  const firstType = functionType([], ["i32"]);
  const secondType = functionType([], ["i32"]);
  const firstSignature = signatureRef("test.first-physical-signature");
  const secondSignature = signatureRef("test.second-physical-signature");
  let firstTypeIndex: number | undefined;
  let secondTypeIndex: number | undefined;

  program.signature({ ref: firstSignature, type: firstType });
  program.signature({ ref: secondSignature, type: secondType });
  program.legacyFunction({
    ref: functionRef("test.first-physical-function"),
    signature: firstSignature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: (bindings) => {
      firstTypeIndex = bindings.typeIndex;
      return new WasmFunctionBodyEncoder().i32Const(1).finish();
    }
  });
  program.legacyFunction({
    ref: functionRef("test.second-physical-function"),
    signature: secondSignature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [],
    build: (bindings) => {
      secondTypeIndex = bindings.typeIndex;
      return new WasmFunctionBodyEncoder().i32Const(2).finish();
    }
  });

  encodeProgram(program.finish());
  strictEqual(firstTypeIndex, 0);
  strictEqual(secondTypeIndex, 0);
});
