import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { WasmFunctionBodyEncoder } from "#compiler/encoder/function-body.js";
import { wasmValueType, type WasmFunctionType } from "#compiler/encoder/types.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import {
  exportRef,
  functionRef,
  resourceRef,
  signatureRef,
  tableRef,
  type GlobalRef
} from "#compiler/program/refs.js";

const voidType = { params: [], results: [] } as const satisfies WasmFunctionType;
const i32Type = { params: [], results: [wasmValueType.i32] } as const satisfies WasmFunctionType;

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
    build: () => {
      buildCount += 1;
      return new WasmFunctionBodyEncoder().i32Const(42).finish();
    }
  });
  program.exportFunction({ ref: exportRef("test.entry"), name: "entry", target: caller });

  const closed = program.finish();

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
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  program.legacyFunction({
    ref: functionRef("test.reviewed"),
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    effects: "none",
    traps: "never",
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  const [defaults, reviewed] = program.finish().functions;

  if (defaults === undefined || reviewed === undefined) {
    throw new Error("missing normalized legacy functions");
  }

  strictEqual(defaults.effects, "world");
  strictEqual(defaults.traps, "may");
  strictEqual(defaults.eliminable, false);
  strictEqual(reviewed.effects, "none");
  strictEqual(reviewed.traps, "never");
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
    () => program.legacyFunction({
      ref: functionRef("test.late-function"),
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
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

test("declarations reject duplicate stable identities and export names", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("same-signature");
  const memory = resourceRef("same-memory");
  const table = tableRef("same-table");
  const fn = functionRef("same-function");

  program.signature({ ref: signature, type: voidType });
  throws(
    () => program.signature({ ref: signatureRef("same-signature"), type: voidType }),
    /duplicate program signature identity/
  );
  program.importMemory({ ref: memory, moduleName: "test", name: "memory", limits: { minPages: 1 } });
  throws(
    () => program.importMemory({
      ref: resourceRef("same-memory"),
      moduleName: "test",
      name: "other",
      limits: { minPages: 1 }
    }),
    /duplicate program resource identity/
  );
  program.importTable({ ref: table, moduleName: "test", name: "table", limits: { minElements: 1 } });
  throws(
    () => program.importTable({
      ref: tableRef("same-table"),
      moduleName: "test",
      name: "other",
      limits: { minElements: 1 }
    }),
    /duplicate program table identity/
  );
  program.legacyFunction({
    ref: fn,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  throws(
    () => program.legacyFunction({
      ref: functionRef("same-function"),
      signature,
      calls: [],
      resources: [],
      globals: [],
      tables: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    }),
    /duplicate program function identity/
  );
  program.exportFunction({ ref: exportRef("same-export"), name: "entry", target: fn });
  throws(
    () => program.exportFunction({ ref: exportRef("same-export"), name: "other", target: fn }),
    /duplicate program export identity/
  );
  throws(
    () => program.exportFunction({ ref: exportRef("different-export"), name: "entry", target: fn }),
    /duplicate program export name/
  );
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
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  program.exportFunction(exported);
  const finished = program.finish();

  exported.name = "after";
  strictEqual(finished.exports[0]?.name, "before");
});

test("closure resolves references by identity and rejects unknown declarations before building", () => {
  const program = new ProgramBuilder();
  const signature = signatureRef("test.signature");
  const declared = functionRef("test.declared");
  const sameIdLookalike = functionRef("test.declared");
  let built = false;

  program.signature({ ref: signature, type: voidType });
  program.legacyFunction({
    ref: declared,
    signature,
    calls: [sameIdLookalike],
    resources: [],
    globals: [],
    tables: [],
    build: () => {
      built = true;
      return new WasmFunctionBodyEncoder().finish();
    }
  });

  throws(() => program.finish(), /unknown program function test\.declared called by function test\.declared/);
  strictEqual(built, false);
});

test("closure rejects unknown resources, tables, globals, signatures, and exports", () => {
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
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => program.finish(), /unknown program resource/);
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
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => program.finish(), /unknown program table/);
  }
  {
    const program = new ProgramBuilder();
    const fn = functionRef("test.global-user");
    const unknownGlobal = resourceRef("test.unknown-global") as unknown as GlobalRef;

    program.signature({ ref: signature, type: voidType });
    program.legacyFunction({
      ref: fn,
      signature,
      calls: [],
      resources: [],
      globals: [unknownGlobal],
      tables: [],
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => program.finish(), /unknown program global/);
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
      build: () => new WasmFunctionBodyEncoder().finish()
    });
    throws(() => program.finish(), /unknown program signature/);
  }
  {
    const program = new ProgramBuilder();

    program.exportFunction({
      ref: exportRef("test.export"),
      name: "entry",
      target: functionRef("test.unknown-function")
    });
    throws(() => program.finish(), /unknown program function/);
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
    build: () => new WasmFunctionBodyEncoder().finish()
  });
  program.legacyFunction({
    ref: subject,
    signature,
    calls: [],
    resources: [],
    globals: [],
    tables: [],
    build: () => new WasmFunctionBodyEncoder().callFunction(0).finish()
  });

  throws(() => encodeProgram(program.finish()), /undeclared Wasm function index 0/);
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
    build: () => new WasmFunctionBodyEncoder().memorySize(0).drop().finish()
  });

  throws(() => encodeProgram(program.finish()), /undeclared Wasm memory index 0/);
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
    build: () => new WasmFunctionBodyEncoder().i32Const(0).callIndirect(0, 0).finish()
  });

  throws(() => encodeProgram(program.finish()), /undeclared Wasm table index 0/);
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
    build: () => new WasmFunctionBodyEncoder().i32Const(0).callIndirect(1, 0).finish()
  });

  throws(() => encodeProgram(program.finish()), /undeclared Wasm type index 1/);
});

test("recorded global indexes reject while globals are outside the 02a program surface", () => {
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
    build: () => new WasmFunctionBodyEncoder().globalGet(0).drop().finish()
  });

  throws(() => encodeProgram(program.finish()), /undeclared Wasm global index 0/);
});
