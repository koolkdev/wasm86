import { deepStrictEqual, ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  resourceRef,
  type ResourceEffect
} from "#compiler/ir/resource.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { createModuleBindings } from "#compiler/program/bindings.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  exportRef,
  functionRef,
  signatureRef,
  tableRef
} from "#compiler/program/refs.js";
import { buildIrBlock } from "#ir/region-builder.js";
import { emitFunction } from "#wasm/emit/action.js";

const noEffects = { reads: [], writes: [] } as const;

test("dead pure indirect invocations retain neither types nor tables", () => {
  const program = new ProgramBuilder();
  const callerType = functionType([], []);
  const indirectType = functionType([], ["i32"]);
  const table = tableRef("test.dead-indirect-table");

  const caller = program.defineFunction({
    ref: functionRef("test.dead-indirect-caller"),
    type: callerType,
    effects: noEffects
  }, (fn) => {
    fn.region.call(fn.region.indirectTarget({
      table,
      type: indirectType,
      effects: noEffects,
      elementIndex: fn.values.const(0)
    }), []);
    fn.return([]);
  });

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === caller.ref);

  if (linked === undefined || linked.kind !== "function") {
    throw new Error("missing dead indirect caller");
  }
  deepStrictEqual(closed.signatures, []);
  deepStrictEqual(closed.functionTypes, [callerType]);
  strictEqual(closed.functionTypes[0], callerType);
  strictEqual(closed.functionTypes.includes(indirectType), false);
  deepStrictEqual(linked.indirectTypes, []);
  deepStrictEqual(linked.tables, []);
  const body = emitFunction(linked.body, {
    bindings: createModuleBindings({
      functionDefinitions: new Map(),
      types: new Map(),
      tables: new Map(),
      resources: new Map()
    }),
    placement: linked.placement
  });

  deepStrictEqual(body.references.typeIndices, []);
  deepStrictEqual(body.references.tableIndices, []);
  encodeProgram(closed);
});

test("resultless indirect invocations retain their declared writes", () => {
  const program = new ProgramBuilder();
  const callerType = functionType([], []);
  const indirectType = functionType([], []);
  const table = tableRef("test.effectful-indirect-table");
  const resource = resourceRef("test.effectful-indirect-resource");
  const write: ResourceEffect = {
    space: "resource",
    resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 4 }
    }
  };
  const effects = { reads: [], writes: [write] } as const;

  program.importMemory({
    ref: resource,
    moduleName: "test",
    name: "effectfulIndirectResource",
    limits: { minPages: 1 }
  });
  program.importTable({
    ref: table,
    moduleName: "test",
    name: "effectfulIndirectTable",
    limits: { minElements: 1 }
  });
  const caller = program.defineFunction({
    ref: functionRef("test.effectful-indirect-caller"),
    type: callerType,
    effects
  }, (fn) => {
    fn.region.call(fn.region.indirectTarget({
      table,
      type: indirectType,
      effects,
      elementIndex: fn.values.const(0)
    }), []);
    fn.return([]);
  });

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === caller.ref);

  if (linked === undefined || linked.kind !== "function") {
    throw new Error("missing effectful indirect caller");
  }
  deepStrictEqual(closed.functionTypes, [callerType, indirectType]);
  strictEqual(closed.functionTypes[0], callerType);
  strictEqual(closed.functionTypes[1], indirectType);
  deepStrictEqual(linked.indirectTypes, [indirectType]);
  deepStrictEqual(linked.tables, [table]);
  deepStrictEqual(linked.resources, []);

  const undeclared = new ProgramBuilder();

  undeclared.importMemory({
    ref: resource,
    moduleName: "test",
    name: "effectfulIndirectResource",
    limits: { minPages: 1 }
  });
  undeclared.importTable({
    ref: table,
    moduleName: "test",
    name: "effectfulIndirectTable",
    limits: { minElements: 1 }
  });
  undeclared.defineFunction({
    ref: functionRef("test.undeclared-effectful-indirect-caller"),
    type: callerType,
    effects: noEffects
  }, (fn) => {
    fn.region.call(fn.region.indirectTarget({
      table,
      type: indirectType,
      effects,
      elementIndex: fn.values.const(0)
    }), []);
    fn.return([]);
  });

  throws(
    () => undeclared.finish(),
    /undeclared-effectful-indirect-caller.*undeclared write effect/
  );
});

test("legacy symbolic blocks inherit live indirect dependencies", async () => {
  const program = new ProgramBuilder();
  const indirectType = functionType([], []);
  const entryType = functionType([], []);
  const signature = signatureRef("test.legacy-indirect-signature");
  const table = tableRef("test.legacy-indirect-table");
  const resource = resourceRef("test.legacy-indirect-resource");
  const write: ResourceEffect = {
    space: "resource",
    resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 4 }
    }
  };
  const effects = { reads: [], writes: [write] } as const;

  let indirectTypeIndex: number | undefined;
  let entryTypeIndex: number | undefined;

  program.signature({ ref: signature, type: entryType });
  program.importMemory({
    ref: resource,
    moduleName: "test",
    name: "legacyIndirectResource",
    limits: { minPages: 1 }
  });
  program.importTable({
    ref: table,
    moduleName: "test",
    name: "legacyIndirectTable",
    limits: { minElements: 1 }
  });
  const target = program.defineFunction({
    ref: functionRef("test.legacy-indirect-target"),
    type: indirectType,
    effects: noEffects
  }, (fn) => fn.return([]));
  const block = buildIrBlock((body) => {
    body.call(body.indirectTarget({
      table,
      type: indirectType,
      effects,
      elementIndex: body.values.const(0)
    }), []);
  });
  const entry = functionRef("test.legacy-indirect-entry");

  program.legacyFunction({
    ref: entry,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    irBlocks: [{ block, allowImplicitEntryFallthrough: true }],
    build: (context) => {
      const typeIndex = context.bindings.typeIndex(indirectType);
      const tableIndex = context.bindings.tableIndex(table);

      indirectTypeIndex = typeIndex;
      entryTypeIndex = context.signatureIndex;

      return new WasmFunctionBodyEncoder()
        .i32Const(0)
        .callIndirect(typeIndex, tableIndex)
        .finish();
    }
  });
  program.exportFunction({
    ref: exportRef("test.legacy-indirect-target-export"),
    name: "target",
    target: target.ref
  });
  program.exportFunction({
    ref: exportRef("test.legacy-indirect-entry-export"),
    name: "entry",
    target: entry
  });

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === entry);

  if (linked === undefined || linked.kind !== "legacy") {
    throw new Error("missing legacy indirect entry");
  }
  deepStrictEqual(closed.functionTypes, [indirectType, entryType]);
  strictEqual(closed.functionTypes[0], indirectType);
  strictEqual(closed.functionTypes[1], entryType);
  deepStrictEqual(linked.indirectTypes, [indirectType]);
  deepStrictEqual(linked.tables, [table]);

  const importedTable = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeProgram(closed)),
    {
      test: {
        legacyIndirectResource: new WebAssembly.Memory({ initial: 1 }),
        legacyIndirectTable: importedTable
      }
    }
  );
  const exportedTarget = instance.exports.target;
  const exportedEntry = instance.exports.entry;

  if (typeof exportedTarget !== "function" || typeof exportedEntry !== "function") {
    throw new Error("missing legacy indirect exports");
  }
  importedTable.set(0, exportedTarget);
  strictEqual(exportedEntry(), undefined);
  strictEqual(indirectTypeIndex, entryTypeIndex);
});

test("defined functions bind ordinary and returning indirect invocations", async () => {
  const program = new ProgramBuilder();
  const type = functionType(["i32"], ["i32"]);
  const table = tableRef("test.indirect-invocation-table");
  const dummyTable = tableRef("test.indirect-invocation-dummy-table");

  program.importTable({
    ref: dummyTable,
    moduleName: "test",
    name: "dummyIndirectInvocationTable",
    limits: { minElements: 1 }
  });
  program.importTable({
    ref: table,
    moduleName: "test",
    name: "indirectInvocationTable",
    limits: { minElements: 1 }
  });
  const target = program.defineFunction({
    ref: functionRef("test.indirect-invocation-target"),
    type,
    effects: noEffects
  }, (fn) => {
    const argument = fn.parameters[0];

    if (argument === undefined) {
      throw new Error("missing indirect target argument");
    }
    fn.return([argument]);
  });
  const ordinary = program.defineFunction({
    ref: functionRef("test.indirect-invocation-ordinary"),
    type,
    effects: noEffects
  }, (fn) => {
    const argument = fn.parameters[0];

    if (argument === undefined) {
      throw new Error("missing ordinary indirect-call argument");
    }
    const results = fn.region.call(fn.region.indirectTarget({
      table,
      type,
      effects: noEffects,
      elementIndex: fn.values.const(0)
    }), [argument]);

    fn.return(results);
  });
  const returning = program.defineFunction({
    ref: functionRef("test.indirect-invocation-returning"),
    type,
    effects: noEffects
  }, (fn) => {
    const argument = fn.parameters[0];

    if (argument === undefined) {
      throw new Error("missing returning indirect-call argument");
    }
    fn.returnCall(fn.region.indirectTarget({
      table,
      type,
      effects: noEffects,
      elementIndex: fn.values.const(0)
    }), [argument]);
  });

  program.exportFunction({
    ref: exportRef("test.indirect-invocation-target-export"),
    name: "target",
    target: target.ref
  });
  program.exportFunction({
    ref: exportRef("test.indirect-invocation-ordinary-export"),
    name: "ordinary",
    target: ordinary.ref
  });
  program.exportFunction({
    ref: exportRef("test.indirect-invocation-returning-export"),
    name: "returning",
    target: returning.ref
  });

  const closed = program.finish();
  const ordinaryFunction = closed.functions.find((fn) => fn.ref === ordinary.ref);
  const returningFunction = closed.functions.find((fn) => fn.ref === returning.ref);

  if (
    ordinaryFunction === undefined ||
    ordinaryFunction.kind !== "function" ||
    returningFunction === undefined ||
    returningFunction.kind !== "function"
  ) {
    throw new Error("missing indirect caller functions");
  }
  deepStrictEqual(closed.signatures, []);
  deepStrictEqual(closed.functionTypes, [type]);
  strictEqual(closed.functionTypes[0], type);
  for (const fn of [ordinaryFunction, returningFunction]) {
    deepStrictEqual(fn.directTargets, []);
    deepStrictEqual(fn.indirectTypes, [type]);
    deepStrictEqual(fn.tables, [table]);
  }

  const bindings = createModuleBindings({
    functionDefinitions: new Map(),
    types: new Map([[type, 5]]),
    tables: new Map([[table, 7]]),
    resources: new Map()
  });
  const ordinaryBody = emitFunction(ordinaryFunction.body, {
    bindings,
    placement: ordinaryFunction.placement
  });
  const returningBody = emitFunction(returningFunction.body, {
    bindings,
    placement: returningFunction.placement
  });

  ok(wasmBodyOpcodes(ordinaryBody.bytes).includes(wasmOpcode.callIndirect));
  ok(wasmBodyOpcodes(returningBody.bytes).includes(wasmOpcode.returnCallIndirect));
  deepStrictEqual(ordinaryBody.references.typeIndices, [5]);
  deepStrictEqual(ordinaryBody.references.tableIndices, [7]);
  deepStrictEqual(returningBody.references.typeIndices, [5]);
  deepStrictEqual(returningBody.references.tableIndices, [7]);

  const importedTable = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const dummyImportedTable = new WebAssembly.Table({ element: "anyfunc", initial: 1 });
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encodeProgram(closed)),
    {
      test: {
        dummyIndirectInvocationTable: dummyImportedTable,
        indirectInvocationTable: importedTable
      }
    }
  );
  const exportedTarget = instance.exports.target;

  if (typeof exportedTarget !== "function") {
    throw new Error("missing exported indirect target");
  }
  importedTable.set(0, exportedTarget);

  const ordinaryEntry = instance.exports.ordinary;
  const returningEntry = instance.exports.returning;

  if (typeof ordinaryEntry !== "function" || typeof returningEntry !== "function") {
    throw new Error("missing exported indirect caller");
  }
  strictEqual(ordinaryEntry(37), 37);
  strictEqual(returningEntry(73), 73);
});

test("defined indirect invocations retain live types and require declared tables", () => {
  {
    const program = new ProgramBuilder();
    const callerType = functionType([], []);
    const indirectType = functionType([], []);
    const table = tableRef("test.closed-indirect-type-table");

    program.importTable({
      ref: table,
      moduleName: "test",
      name: "closedIndirectTypeTable",
      limits: { minElements: 1 }
    });
    program.defineFunction({
      ref: functionRef("test.closed-indirect-type-function"),
      type: callerType,
      effects: noEffects
    }, (fn) => {
      fn.returnCall(fn.region.indirectTarget({
        table,
        type: indirectType,
        effects: noEffects,
        elementIndex: fn.values.const(0)
      }), []);
    });

    const closed = program.finish();

    deepStrictEqual(closed.functionTypes, [callerType, indirectType]);
    strictEqual(closed.functionTypes[0], callerType);
    strictEqual(closed.functionTypes[1], indirectType);
    encodeProgram(closed);
  }
  {
    const program = new ProgramBuilder();
    const type = functionType([], []);
    const table = tableRef("test.unknown-indirect-table");

    program.defineFunction({
      ref: functionRef("test.unknown-indirect-table-function"),
      type,
      effects: noEffects
    }, (fn) => {
      fn.returnCall(fn.region.indirectTarget({
        table,
        type,
        effects: noEffects,
        elementIndex: fn.values.const(0)
      }), []);
    });

    throws(() => program.finish(), /unknown program table/);
  }
});
