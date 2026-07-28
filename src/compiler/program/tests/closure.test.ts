import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { functionType } from "#compiler/ir/function.js";
import { resourceRead, resourceWrite } from "#compiler/ir/operations/resource.js";
import { resourceRef, type ByteRange, type ResourceEffect } from "#compiler/ir/resource.js";
import { functionRef, tableRef } from "#compiler/ir/refs.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { FunctionFamily, type FunctionDefinition } from "#compiler/program/functions.js";
import { createProgramResources } from "#compiler/program/resources.js";

const voidType = functionType([], []);
const i32Type = functionType([], ["i32"]);
const noEffects = { reads: [], writes: [] } as const;
const emptyResources = createProgramResources([]);

test("closure builds functions that refer to later definitions", () => {
  const program = new ProgramBuilder(emptyResources);
  let buildCount = 0;
  let callee!: FunctionDefinition;

  const caller = program.defineFunction(
    {
      ref: functionRef("test.caller"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      buildCount += 1;
      const result = fn.region.call(callee, [])[0];

      assert(result !== undefined, "missing forward callee result");
      fn.return([result]);
    }
  );
  callee = program.defineFunction(
    {
      ref: functionRef("test.callee"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      buildCount += 1;
      fn.return([fn.values.const(42)]);
    }
  );

  const closed = program.finish();
  const linkedCaller = closed.functions.find((fn) => fn.ref === caller.ref);

  assert(linkedCaller !== undefined, "missing forward caller");
  strictEqual(buildCount, 2);
  strictEqual(closed.functionTypes.includes(i32Type), true);
  strictEqual(linkedCaller.directFunctions.includes(callee.ref), true);
});

test("closure retains only function imports reached by live calls", () => {
  const program = new ProgramBuilder(emptyResources);
  const liveType = functionType(["i32"], ["i32"]);
  const deadType = functionType([], ["i64"]);
  const live = program.importFunction({
    ref: functionRef("test.live-import"),
    type: liveType,
    effects: noEffects,
    moduleName: "test",
    name: "live"
  });
  const dead = program.importFunction({
    ref: functionRef("test.dead-import"),
    type: deadType,
    effects: noEffects,
    moduleName: "test",
    name: "dead"
  });

  program.defineFunction(
    {
      ref: functionRef("test.import-caller"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      fn.region.call(dead, []);
      const result = fn.region.call(live, [fn.values.const(41)])[0];

      assert(result !== undefined, "missing imported-call result");
      fn.return([result]);
    }
  );

  const closed = program.finish();

  strictEqual(closed.functionImports.includes(live), true);
  strictEqual(closed.functionImports.includes(dead), false);
  strictEqual(closed.functionTypes.includes(liveType), true);
  strictEqual(closed.functionTypes.includes(deadType), false);
});

test("closure retains only resources used by live operations", () => {
  const usedMemory = {
    ref: resourceRef("test.used-memory"),
    moduleName: "test",
    name: "usedMemory",
    limits: { minPages: 1 }
  };
  const unusedMemory = {
    ref: resourceRef("test.unused-memory"),
    moduleName: "test",
    name: "unusedMemory",
    limits: { minPages: 1 }
  };
  const program = new ProgramBuilder(createProgramResources([unusedMemory, usedMemory]));
  const range: ByteRange = {
    basis: { kind: "resource" },
    slice: { byteOffset: 12, byteLength: 2 }
  };
  const access: ResourceEffect = {
    space: "resource",
    resource: usedMemory.ref,
    range
  };

  const definition = program.defineFunction(
    {
      ref: functionRef("test.resource-operation-function"),
      type: i32Type,
      effects: { reads: [access], writes: [access] }
    },
    (fn) => {
      const address = fn.values.const(6);

      fn.region.operation(resourceWrite, {
        destination: {
          effect: access,
          address: { base: address, displacement: 6 },
          width: 16
        },
        value: fn.values.const(0x1234)
      });
      const read = fn.region.operation(resourceRead, {
        source: {
          effect: access,
          address: { base: address, displacement: 6 },
          width: 16
        }
      });

      fn.return([read]);
    }
  );

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === definition.ref);

  assert(linked !== undefined, "missing resource operation function");
  deepStrictEqual(linked.resources, [usedMemory.ref]);
  deepStrictEqual(closed.memoryImports, [usedMemory]);
});

test("closure omits resources used only by dead operations", () => {
  const memory = {
    ref: resourceRef("test.dead-read-memory"),
    moduleName: "test",
    name: "deadReadMemory",
    limits: { minPages: 1 }
  };
  const program = new ProgramBuilder(createProgramResources([memory]));
  const access: ResourceEffect = {
    space: "resource",
    resource: memory.ref,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 1 }
    }
  };

  const definition = program.defineFunction(
    {
      ref: functionRef("test.dead-resource-function"),
      type: i32Type,
      effects: { reads: [access], writes: [] }
    },
    (fn) => {
      fn.region.operation(resourceRead, {
        source: {
          effect: access,
          address: { base: fn.values.const(0), displacement: 0 },
          width: 8
        }
      });
      fn.return([fn.values.const(7)]);
    }
  );

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === definition.ref);

  assert(linked !== undefined, "missing dead resource function");
  deepStrictEqual(linked.resources, []);
  deepStrictEqual(closed.memoryImports, []);
});

test("closure rejects a live operation on an unknown resource", () => {
  const program = new ProgramBuilder(emptyResources);
  const resource = resourceRef("test.unknown-resource");
  const effect: ResourceEffect = {
    space: "resource",
    resource,
    range: { basis: { kind: "resource" } }
  };

  program.defineFunction(
    {
      ref: functionRef("test.unknown-resource-function"),
      type: i32Type,
      effects: noEffects
    },
    (fn) => {
      fn.return([
        fn.region.operation(resourceRead, {
          source: {
            effect,
            address: { base: fn.values.const(0), displacement: 0 },
            width: 8
          }
        })
      ]);
    }
  );

  throws(
    () => program.finish(),
    /unknown program resource test\.unknown-resource used by function test\.unknown-resource-function/
  );
});

test("function resources describe direct operations rather than callee effects", () => {
  const memory = {
    ref: resourceRef("test.effect-memory"),
    moduleName: "test",
    name: "effectMemory",
    limits: { minPages: 1 }
  };
  const program = new ProgramBuilder(createProgramResources([memory]));
  const type = functionType(["i32"], []);
  const effect: ResourceEffect = {
    space: "resource",
    resource: memory.ref,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 4 }
    }
  };
  const effects = { reads: [], writes: [effect] } as const;

  const callee = program.defineFunction(
    {
      ref: functionRef("test.effects-callee"),
      type,
      effects
    },
    (fn) => {
      const value = fn.parameters[0];

      assert(value !== undefined, "missing callee parameter");
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
  const caller = program.defineFunction(
    {
      ref: functionRef("test.effects-caller"),
      type,
      effects
    },
    (fn) => {
      const value = fn.parameters[0];

      assert(value !== undefined, "missing caller parameter");
      fn.region.call(callee, [value]);
      fn.return([]);
    }
  );

  const closed = program.finish();

  deepStrictEqual(closed.functions.find((fn) => fn.ref === callee.ref)?.resources, [memory.ref]);
  deepStrictEqual(closed.functions.find((fn) => fn.ref === caller.ref)?.resources, []);
});

test("closure omits a dead pure indirect call and its table type", () => {
  const program = new ProgramBuilder(emptyResources);
  const indirectType = functionType([], ["i32"]);
  const table = tableRef("test.dead-indirect-table");

  const caller = program.defineFunction(
    {
      ref: functionRef("test.dead-indirect-caller"),
      type: voidType,
      effects: noEffects
    },
    (fn) => {
      fn.region.call(
        fn.region.indirectTarget({
          table,
          type: indirectType,
          effects: noEffects,
          elementIndex: fn.values.const(0)
        }),
        []
      );
      fn.return([]);
    }
  );

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === caller.ref);

  assert(linked !== undefined, "missing dead indirect caller");
  strictEqual(closed.functionTypes.includes(indirectType), false);
  strictEqual(linked.indirectTypes.length, 0);
  strictEqual(linked.tables.length, 0);
});

test("closure retains a live resultless indirect call and its table type", () => {
  const memory = {
    ref: resourceRef("test.indirect-effect-memory"),
    moduleName: "test",
    name: "indirectEffectMemory",
    limits: { minPages: 1 }
  };
  const program = new ProgramBuilder(createProgramResources([memory]));
  const indirectType = functionType([], []);
  const table = tableRef("test.effectful-indirect-table");
  const effect: ResourceEffect = {
    space: "resource",
    resource: memory.ref,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset: 0, byteLength: 4 }
    }
  };
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
  const caller = program.defineFunction(
    {
      ref: functionRef("test.effectful-indirect-caller"),
      type: voidType,
      effects
    },
    (fn) => {
      fn.region.call(
        fn.region.indirectTarget({
          table,
          type: indirectType,
          effects,
          elementIndex: fn.values.const(0)
        }),
        []
      );
      fn.return([]);
    }
  );

  const closed = program.finish();
  const linked = closed.functions.find((fn) => fn.ref === caller.ref);

  assert(linked !== undefined, "missing effectful indirect caller");
  strictEqual(closed.functionTypes.includes(indirectType), true);
  strictEqual(linked.indirectTypes.includes(indirectType), true);
  strictEqual(linked.tables.includes(table), true);
});

test("closure rejects defined functions owned by another program", () => {
  const owner = new ProgramBuilder(emptyResources);
  const consumer = new ProgramBuilder(emptyResources);
  const type = functionType([], ["i32"]);
  const owned = owner.defineFunction(
    {
      ref: functionRef("test.owned-function"),
      type,
      effects: noEffects
    },
    (fn) => fn.return([fn.values.const(1)])
  );

  consumer.defineFunction(
    {
      ref: functionRef("test.cross-program-root"),
      type,
      effects: noEffects
    },
    (fn) => {
      const result = fn.region.call(owned, [])[0];

      assert(result !== undefined, "missing cross-program result");
      fn.return([result]);
    }
  );

  throws(() => consumer.finish(), /belongs to another program/);
});

test("closure rejects function imports owned by another program", () => {
  const owner = new ProgramBuilder(emptyResources);
  const foreign = owner.importFunction({
    ref: functionRef("test.foreign-import"),
    type: voidType,
    effects: noEffects,
    moduleName: "test",
    name: "foreign"
  });
  const consumer = new ProgramBuilder(emptyResources);

  consumer.defineFunction(
    {
      ref: functionRef("test.foreign-import-caller"),
      type: voidType,
      effects: noEffects
    },
    (fn) => fn.returnCall(foreign, [])
  );

  throws(() => consumer.finish(), /belongs to another program/);
});

test("closure retains reachable function-family members only", () => {
  const program = new ProgramBuilder(emptyResources);
  const rootType = functionType([], ["i64"]);
  const liveType = functionType([], ["i64"]);
  const transitiveType = functionType([], ["i64"]);
  const deadType = functionType([], []);
  const builds = new Set<string>();
  const transitiveFamily = new FunctionFamily<number>({
    type: transitiveType,
    effects: () => noEffects,
    id: (key) => `test.generated.transitive.${key}`,
    build: (key, fn) => {
      builds.add(`transitive-${key}`);
      fn.return([fn.values.const64(BigInt(key))]);
    }
  });
  const transitive = transitiveFamily.get(3);
  const liveFamily = new FunctionFamily<number>({
    type: liveType,
    effects: () => noEffects,
    id: (key) => `test.generated.live.${key}`,
    build: (key, fn) => {
      builds.add(`live-${key}`);
      const result = fn.region.call(transitive, [])[0];

      assert(result !== undefined, "missing transitive generated result");
      fn.return([result]);
    }
  });
  const deadFamily = new FunctionFamily<number>({
    type: deadType,
    effects: () => noEffects,
    id: (key) => `test.generated.dead.${key}`,
    build: (key, fn) => {
      builds.add(`dead-${key}`);
      fn.return([]);
    }
  });
  const live = liveFamily.get(2);
  const dead = deadFamily.get(1);
  const root = program.defineFunction(
    {
      ref: functionRef("test.generated.root"),
      type: rootType,
      effects: noEffects
    },
    (fn) => {
      fn.region.call(dead, []);
      const result = fn.region.call(live, [])[0];

      assert(result !== undefined, "missing live generated result");
      fn.return([result]);
    }
  );

  const closed = program.finish();

  strictEqual(
    closed.functions.some((fn) => fn.ref === root.ref),
    true
  );
  strictEqual(
    closed.functions.some((fn) => fn.ref === live.ref),
    true
  );
  strictEqual(
    closed.functions.some((fn) => fn.ref === transitive.ref),
    true
  );
  strictEqual(
    closed.functions.some((fn) => fn.ref === dead.ref),
    false
  );
  strictEqual(closed.functionTypes.includes(rootType), true);
  strictEqual(closed.functionTypes.includes(liveType), true);
  strictEqual(closed.functionTypes.includes(transitiveType), true);
  strictEqual(closed.functionTypes.includes(deadType), false);
  deepStrictEqual(builds, new Set(["live-2", "transitive-3"]));
});
