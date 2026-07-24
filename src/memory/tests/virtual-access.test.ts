import {
  deepStrictEqual,
  ok,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { assert } from "#common/assert.js";
import { compileProgram } from "#compiler/compile.js";
import { instantiateCompiledProgram } from "#compiler/instantiate.js";
import { functionType } from "#compiler/ir/function.js";
import { functionRef } from "#compiler/ir/refs.js";
import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { functionExportRef } from "#compiler/program/exports.js";
import { createProgramResources } from "#compiler/program/resources.js";
import type { MemoryAccessIntent } from "#memory/types.js";
import { createMachineMemoryDefinition } from "#memory/machine-memory.js";
import { createPhysicalAddressSpaceDefinition } from "#memory/physical.js";
import { createVirtualAccessDefinition } from "#memory/virtual/access.js";
import { pageTableEntries } from "#memory/virtual/layout.js";

const faultProjection = {
  condition: 0,
  linearAddress: 1,
  errorCode: 2
} as const;
const rmwFaultSentinel = -1;

const classifierType = functionType(
  ["i32", "i32", "i32"],
  ["i32"]
);
const rmwType = functionType(["i32"], ["i32"]);
const storeType = functionType(["i32", "i32"], ["i32"]);

const classifierEntries = {
  read: {
    ref: functionRef("memory.virtual.test.classify-read"),
    exportRef: functionExportRef(
      "memory.virtual.test.classify-read-export"
    ),
    exportName: "classifyRead"
  },
  write: {
    ref: functionRef("memory.virtual.test.classify-write"),
    exportRef: functionExportRef(
      "memory.virtual.test.classify-write-export"
    ),
    exportName: "classifyWrite"
  },
  instructionFetch: {
    ref: functionRef("memory.virtual.test.classify-fetch"),
    exportRef: functionExportRef(
      "memory.virtual.test.classify-fetch-export"
    ),
    exportName: "classifyFetch"
  }
} as const;

const rmwEntry = {
  ref: functionRef("memory.virtual.test.rmw"),
  exportRef: functionExportRef("memory.virtual.test.rmw-export"),
  exportName: "rmw"
} as const;

const scalarReadEntries = {
  read16Unsigned: {
    ref: functionRef("memory.virtual.test.read16-unsigned"),
    exportRef: functionExportRef(
      "memory.virtual.test.read16-unsigned-export"
    ),
    exportName: "read16Unsigned",
    width: 16,
    signed: false
  },
  read16Signed: {
    ref: functionRef("memory.virtual.test.read16-signed"),
    exportRef: functionExportRef(
      "memory.virtual.test.read16-signed-export"
    ),
    exportName: "read16Signed",
    width: 16,
    signed: true
  },
  read32: {
    ref: functionRef("memory.virtual.test.read32"),
    exportRef: functionExportRef(
      "memory.virtual.test.read32-export"
    ),
    exportName: "read32",
    width: 32,
    signed: false
  }
} as const;

const scalarStoreEntries = {
  store16: {
    ref: functionRef("memory.virtual.test.store16"),
    exportRef: functionExportRef("memory.virtual.test.store16-export"),
    exportName: "store16",
    width: 16
  },
  store32: {
    ref: functionRef("memory.virtual.test.store32"),
    exportRef: functionExportRef("memory.virtual.test.store32-export"),
    exportName: "store32",
    width: 32
  }
} as const;

const byteSubaccessEntry = {
  ref: functionRef("memory.virtual.test.byte-subaccess"),
  exportRef: functionExportRef(
    "memory.virtual.test.byte-subaccess-export"
  ),
  exportName: "byteSubaccess"
} as const;

const physical = createPhysicalAddressSpaceDefinition();
const machineMemoryDefinition = createMachineMemoryDefinition();
const virtualAccess = createVirtualAccessDefinition(
  physical,
  machineMemoryDefinition
);
const compiledTestProgram = compileProgram(buildVirtualAccessTestProgram());

type Classifier = (
  start: number,
  byteLength: number,
  projection: number
) => number;

type ScalarRead = (start: number) => number;
type ScalarStore = (start: number, value: number) => number;

type FaultClassification = Readonly<{
  condition: number;
  linearAddress: number;
  errorCode: number;
}>;

type VirtualAccessFixture = Readonly<{
  ram: WebAssembly.Memory;
  writePte(pageIndex: number, entry: number): void;
  classify(
    intent: MemoryAccessIntent,
    start: number,
    byteLength: number
  ): FaultClassification;
  read16Unsigned(start: number): number;
  read16Signed(start: number): number;
  read32(start: number): number;
  store16(start: number, value: number): number;
  store32(start: number, value: number): number;
  byteSubaccess(start: number, value: number): number;
  rmw(start: number): number;
}>;

test("generated Virtual resolution rejects empty and wrapping ranges at their original start", () => {
  const fixture = createVirtualAccessFixture();

  fixture.writePte(1, 0x0000_1003);

  deepStrictEqual(
    fixture.classify("read", 0x1234, 0),
    {
      condition: 1,
      linearAddress: 0x1234,
      errorCode: 0
    }
  );
  fixture.writePte(0xfffff, 0x0000_5003);
  fixture.writePte(0, 0x0000_6003);
  deepStrictEqual(
    fixture.classify("write", 0xffff_fffe, 4),
    {
      condition: 1,
      linearAddress: 0xffff_fffe,
      errorCode: 2
    }
  );
});

test("generated Virtual resolution reports the first denied linear address", () => {
  const fixture = createVirtualAccessFixture();

  deepStrictEqual(
    fixture.classify("read", 0x4234, 1),
    {
      condition: 1,
      linearAddress: 0x4234,
      errorCode: 0
    }
  );

  fixture.writePte(1, 0x0000_1003);
  fixture.writePte(3, 0x0000_3003);

  deepStrictEqual(
    fixture.classify("read", 0x1ffe, 0x1004),
    {
      condition: 1,
      linearAddress: 0x2000,
      errorCode: 0
    }
  );
});

test("generated Virtual faults distinguish presence and access intent", () => {
  const fixture = createVirtualAccessFixture();
  const address = 0x4234;

  strictEqual(
    fixture.classify("read", address, 1).errorCode,
    0
  );
  strictEqual(
    fixture.classify("write", address, 1).errorCode,
    2
  );
  deepStrictEqual(
    fixture.classify("instructionFetch", address, 1),
    {
      condition: 1,
      linearAddress: address,
      errorCode: 16
    }
  );

  fixture.writePte(4, 0x0000_4001);

  strictEqual(
    fixture.classify("read", address, 1).condition,
    0
  );
  deepStrictEqual(
    fixture.classify("write", address, 1),
    {
      condition: 1,
      linearAddress: address,
      errorCode: 3
    }
  );
});

test("generated Virtual RMW transfers through Physical only after admission", () => {
  const fixture = createVirtualAccessFixture();
  const address = 0x1ffe;
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_1003);
  fixture.writePte(2, 0x0000_2003);
  view.setUint32(address, 0x1234_5678, true);

  strictEqual(fixture.rmw(address), 0x1234_5678);
  strictEqual(view.getUint32(address, true), 0x1234_5679);

  fixture.writePte(2, 0);
  view.setUint32(address, 0x1020_3040, true);

  strictEqual(fixture.rmw(address), rmwFaultSentinel);
  strictEqual(view.getUint32(address, true), 0x1020_3040);
});

test("generated Virtual same-page RMW uses a nonidentity frame and page offset", () => {
  const fixture = createVirtualAccessFixture();
  const linearAddress = 0x1120;
  const physicalAddress = 0x3120;
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_3003);
  view.setUint32(physicalAddress, 0x1234_5678, true);
  view.setUint32(linearAddress, 0xaabb_ccdd, true);

  strictEqual(fixture.rmw(linearAddress), 0x1234_5678);
  strictEqual(view.getUint32(physicalAddress, true), 0x1234_5679);
  strictEqual(view.getUint32(linearAddress, true), 0xaabb_ccdd);
});

test("generated Virtual cross-page RMW follows contiguous nonidentity frames", () => {
  const fixture = createVirtualAccessFixture();
  const linearAddress = 0x1ffe;
  const physicalAddress = 0x3ffe;
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_3003);
  fixture.writePte(2, 0x0000_4003);
  view.setUint32(physicalAddress, 0x1234_5678, true);
  view.setUint32(linearAddress, 0xaabb_ccdd, true);

  strictEqual(fixture.rmw(linearAddress), 0x1234_5678);
  strictEqual(view.getUint32(physicalAddress, true), 0x1234_5679);
  strictEqual(view.getUint32(linearAddress, true), 0xaabb_ccdd);
});

test("generated Virtual scattered word reads assemble unsigned and signed values", () => {
  const fixture = createVirtualAccessFixture();
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_3003);
  fixture.writePte(2, 0x0000_1003);
  view.setUint8(0x3fff, 0x80);
  view.setUint8(0x1000, 0xff);

  strictEqual(fixture.read16Unsigned(0x1fff), 0xff80);
  strictEqual(fixture.read16Signed(0x1fff), -128);
});

test("generated Virtual discontinuous byte subaccesses and word stores follow both frames", () => {
  const fixture = createVirtualAccessFixture();
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_3003);
  fixture.writePte(2, 0x0000_1003);
  view.setUint8(0x3fff, 0x80);
  view.setUint8(0x1000, 0x55);

  strictEqual(fixture.byteSubaccess(0x1fff, 0x7a), 0x80);
  strictEqual(view.getUint8(0x3fff), 0x80);
  strictEqual(view.getUint8(0x1000), 0x7a);

  strictEqual(fixture.store16(0x1fff, 0x1234), 0);
  strictEqual(view.getUint8(0x3fff), 0x34);
  strictEqual(view.getUint8(0x1000), 0x12);
});

test("generated Virtual scattered dword reads and stores cross physical frames", () => {
  const fixture = createVirtualAccessFixture();
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_3003);
  fixture.writePte(2, 0x0000_1003);
  view.setUint8(0x3ffe, 0x78);
  view.setUint8(0x3fff, 0x56);
  view.setUint8(0x1000, 0x34);
  view.setUint8(0x1001, 0x12);

  strictEqual(fixture.read32(0x1ffe), 0x1234_5678);
  strictEqual(fixture.store32(0x1ffe, 0x0bad_f00d), 0);
  deepStrictEqual(
    [
      view.getUint8(0x3ffe),
      view.getUint8(0x3fff),
      view.getUint8(0x1000),
      view.getUint8(0x1001)
    ],
    [0x0d, 0xf0, 0xad, 0x0b]
  );
});

test("generated Virtual scattered RMW reuses its admitted write access", () => {
  const fixture = createVirtualAccessFixture();
  const view = new DataView(fixture.ram.buffer);

  fixture.writePte(1, 0x0000_3003);
  fixture.writePte(2, 0x0000_1003);
  view.setUint8(0x3ffe, 0xff);
  view.setUint8(0x3fff, 0xff);
  view.setUint8(0x1000, 0xff);
  view.setUint8(0x1001, 0x12);

  strictEqual(fixture.rmw(0x1ffe), 0x12ff_ffff);
  deepStrictEqual(
    [
      view.getUint8(0x3ffe),
      view.getUint8(0x3fff),
      view.getUint8(0x1000),
      view.getUint8(0x1001)
    ],
    [0, 0, 0, 0x13]
  );
});

test("generated Virtual scattered write denial precedes physical mutation", () => {
  const fixture = createVirtualAccessFixture();
  const view = new DataView(fixture.ram.buffer);
  const initialBytes = [0x40, 0x30, 0x20, 0x10];

  fixture.writePte(1, 0x0000_3003);
  fixture.writePte(2, 0x0000_1001);
  view.setUint8(0x3ffe, initialBytes[0]!);
  view.setUint8(0x3fff, initialBytes[1]!);
  view.setUint8(0x1000, initialBytes[2]!);
  view.setUint8(0x1001, initialBytes[3]!);

  deepStrictEqual(
    fixture.classify("write", 0x1ffe, 4),
    {
      condition: 1,
      linearAddress: 0x2000,
      errorCode: 3
    }
  );
  strictEqual(fixture.rmw(0x1ffe), rmwFaultSentinel);
  deepStrictEqual(
    [
      view.getUint8(0x3ffe),
      view.getUint8(0x3fff),
      view.getUint8(0x1000),
      view.getUint8(0x1001)
    ],
    initialBytes
  );
});

function buildVirtualAccessTestProgram() {
  const builder = new ProgramBuilder(createProgramResources([
    ...physical.resources,
    ...machineMemoryDefinition.resources
  ]));

  for (const intent of [
    "read",
    "write",
    "instructionFetch"
  ] as const) {
    const entry = classifierEntries[intent];

    builder.defineFunction({
      ref: entry.ref,
      type: classifierType,
      effects: virtualAccess.effects
    }, (fn) => {
      const start = fn.parameters[0];
      const byteLength = fn.parameters[1];
      const projection = fn.parameters[2];

      assert(start !== undefined, "Virtual classifier start is missing");
      assert(
        byteLength !== undefined,
        "Virtual classifier byte length is missing"
      );
      assert(
        projection !== undefined,
        "Virtual classifier projection is missing"
      );
      const resolution = virtualAccess.access.bind(fn.region).resolve(
        { start, byteLength },
        intent
      );
      const projected = fn.region.switch(
        projection,
        [{
          match: faultProjection.condition,
          build: () => resolution.fault.condition
        }, {
          match: faultProjection.linearAddress,
          build: () => resolution.fault.exception.linearAddress
        }],
        () => resolution.fault.exception.errorCode
      );

      fn.return([projected]);
    });
    builder.exportFunction({
      ref: entry.exportRef,
      name: entry.exportName,
      target: entry.ref
    });
  }

  for (const entry of Object.values(scalarReadEntries)) {
    builder.defineFunction({
      ref: entry.ref,
      type: rmwType,
      effects: virtualAccess.effects
    }, (fn) => {
      const start = fn.parameters[0];

      assert(start !== undefined, `${entry.exportName} start is missing`);
      const resolution = virtualAccess.access.bind(fn.region).resolve(
        {
          start,
          byteLength: fn.values.const(entry.width / 8)
        },
        "read"
      );
      const result = fn.region.ifValue(
        resolution.fault.condition,
        (fault) => fault.values.const(rmwFaultSentinel),
        (admitted) => virtualAccess.access.bind(admitted).load(
          resolution.access,
          admitted.values.const(0),
          entry.width,
          { signed: entry.signed }
        ),
        { hint: "unlikely" }
      );

      fn.return([result]);
    });
    builder.exportFunction({
      ref: entry.exportRef,
      name: entry.exportName,
      target: entry.ref
    });
  }

  for (const entry of Object.values(scalarStoreEntries)) {
    builder.defineFunction({
      ref: entry.ref,
      type: storeType,
      effects: virtualAccess.effects
    }, (fn) => {
      const start = fn.parameters[0];
      const value = fn.parameters[1];

      assert(start !== undefined, `${entry.exportName} start is missing`);
      assert(value !== undefined, `${entry.exportName} value is missing`);
      const resolution = virtualAccess.access.bind(fn.region).resolve(
        {
          start,
          byteLength: fn.values.const(entry.width / 8)
        },
        "write"
      );
      const result = fn.region.ifValue(
        resolution.fault.condition,
        (fault) => fault.values.const(1),
        (admitted) => {
          virtualAccess.access.bind(admitted).store(
            resolution.access,
            admitted.values.const(0),
            value,
            entry.width
          );
          return admitted.values.const(0);
        },
        { hint: "unlikely" }
      );

      fn.return([result]);
    });
    builder.exportFunction({
      ref: entry.exportRef,
      name: entry.exportName,
      target: entry.ref
    });
  }

  builder.defineFunction({
    ref: byteSubaccessEntry.ref,
    type: storeType,
    effects: virtualAccess.effects
  }, (fn) => {
    const start = fn.parameters[0];
    const value = fn.parameters[1];

    assert(start !== undefined, "Virtual byte subaccess start is missing");
    assert(value !== undefined, "Virtual byte subaccess value is missing");
    const resolution = virtualAccess.access.bind(fn.region).resolve(
      {
        start,
        byteLength: fn.values.const(2)
      },
      "write"
    );
    const result = fn.region.ifValue(
      resolution.fault.condition,
      (fault) => fault.values.const(rmwFaultSentinel),
      (admitted) => {
        const memory = virtualAccess.access.bind(admitted);
        const current = memory.load(
          resolution.access,
          admitted.values.const(0),
          8
        );

        memory.store(
          resolution.access,
          admitted.values.const(1),
          value,
          8
        );
        return current;
      },
      { hint: "unlikely" }
    );

    fn.return([result]);
  });
  builder.exportFunction({
    ref: byteSubaccessEntry.exportRef,
    name: byteSubaccessEntry.exportName,
    target: byteSubaccessEntry.ref
  });

  builder.defineFunction({
    ref: rmwEntry.ref,
    type: rmwType,
    effects: virtualAccess.effects
  }, (fn) => {
    const start = fn.parameters[0];

    assert(start !== undefined, "Virtual RMW start is missing");
    const resolution = virtualAccess.access.bind(fn.region).resolve(
      {
        start,
        byteLength: fn.values.const(4)
      },
      "write"
    );
    const result = fn.region.ifValue(
      resolution.fault.condition,
      (fault) => fault.values.const(rmwFaultSentinel),
      (admitted) => {
        const memory = virtualAccess.access.bind(admitted);
        const zero = admitted.values.const(0);
        const current = memory.load(
          resolution.access,
          zero,
          32
        );

        memory.store(
          resolution.access,
          zero,
          admitted.values.binary(
            "add",
            current,
            admitted.values.const(1)
          ),
          32
        );
        return current;
      },
      { hint: "unlikely" }
    );

    fn.return([result]);
  });
  builder.exportFunction({
    ref: rmwEntry.exportRef,
    name: rmwEntry.exportName,
    target: rmwEntry.ref
  });

  return builder.finish();
}

function createVirtualAccessFixture(): VirtualAccessFixture {
  const ram = new WebAssembly.Memory({
    initial: physical.ramImport.limits.minPages
  });
  const machine = new WebAssembly.Memory({
    initial: machineMemoryDefinition.memoryImport.limits.minPages
  });
  const instance = instantiateCompiledProgram(compiledTestProgram, {
    memories: new Map([
      [physical.ramResource, ram],
      [machineMemoryDefinition.resource, machine]
    ]),
    functions: new Map()
  });
  const classifiers = new Map<MemoryAccessIntent, Classifier>();

  for (const intent of [
    "read",
    "write",
    "instructionFetch"
  ] as const) {
    const entry = instance.functionExports.get(
      classifierEntries[intent].exportRef
    );

    ok(
      typeof entry === "function",
      `Virtual ${intent} classifier export is missing`
    );
    classifiers.set(intent, entry as Classifier);
  }
  const read16Unsigned = instance.functionExports.get(
    scalarReadEntries.read16Unsigned.exportRef
  );
  const read16Signed = instance.functionExports.get(
    scalarReadEntries.read16Signed.exportRef
  );
  const read32 = instance.functionExports.get(
    scalarReadEntries.read32.exportRef
  );
  const store16 = instance.functionExports.get(
    scalarStoreEntries.store16.exportRef
  );
  const store32 = instance.functionExports.get(
    scalarStoreEntries.store32.exportRef
  );
  const byteSubaccess = instance.functionExports.get(
    byteSubaccessEntry.exportRef
  );
  const rmw = instance.functionExports.get(rmwEntry.exportRef);

  ok(
    typeof read16Unsigned === "function",
    "Virtual unsigned word read export is missing"
  );
  ok(
    typeof read16Signed === "function",
    "Virtual signed word read export is missing"
  );
  ok(typeof read32 === "function", "Virtual dword read export is missing");
  ok(typeof store16 === "function", "Virtual word store export is missing");
  ok(typeof store32 === "function", "Virtual dword store export is missing");
  ok(
    typeof byteSubaccess === "function",
    "Virtual byte subaccess export is missing"
  );
  ok(typeof rmw === "function", "Virtual RMW export is missing");
  const machineView = createLayoutHostView(
    machine,
    machineMemoryDefinition.layout
  );

  return {
    ram,
    writePte: (pageIndex, entry) => {
      machineView.writeArrayElement(
        pageTableEntries,
        pageIndex,
        0,
        4,
        entry
      );
    },
    classify: (intent, start, byteLength) => {
      const classify = classifiers.get(intent);

      assert(
        classify !== undefined,
        `Virtual ${intent} classifier is missing`
      );
      return {
        condition: classify(
          start,
          byteLength,
          faultProjection.condition
        ),
        linearAddress: classify(
          start,
          byteLength,
          faultProjection.linearAddress
        ) >>> 0,
        errorCode: classify(
          start,
          byteLength,
          faultProjection.errorCode
        ) >>> 0
      };
    },
    read16Unsigned: read16Unsigned as ScalarRead,
    read16Signed: read16Signed as ScalarRead,
    read32: read32 as ScalarRead,
    store16: store16 as ScalarStore,
    store32: store32 as ScalarStore,
    byteSubaccess: byteSubaccess as ScalarStore,
    rmw: rmw as (start: number) => number
  };
}
