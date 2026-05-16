import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  wasmOpcode,
  wasmBodyLocalCount,
  wasmBodyOpcodes,
  LocalStore,
  captureExitStores,
  releaseExitStores,
  addValue,
  highCostValue,
  emitAdd,
  emitXorOfAdds,
  emitHighCostValue,
  unexpectedEmitter,
  branchPath,
  rootPath,
  emitWithLocalStore,
  captureWithLocalStore,
  cacheRuntimeForStore,
  localOpcodes,
  countOpcode,
  type JitValue,
} from "./value-local-store-test-helpers.js";
import { throws } from "node:assert";
import type { Capture } from "#backends/wasm/jit/codegen/plan/captures.js";
test("LocalStore reuses one local for equal non-trivial values", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = addValue("eax", 1);
  const second = addValue("eax", 1);
  const store = new LocalStore(body);
  let emitted = 0;

  emitWithLocalStore(store, first, () => emitAdd(body, () => { emitted += 1; }));
  emitWithLocalStore(store, second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Add), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("LocalStore reuses structurally equal binary expressions", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addValue("eax", 1),
    b: addValue("ebx", 2)
  } as const satisfies JitValue;
  const second = {
    kind: "value.binary",
    type: "i32",
    operator: "xor",
    a: addValue("eax", 1),
    b: addValue("ebx", 2)
  } as const satisfies JitValue;
  const store = new LocalStore(body);
  let emitted = 0;

  emitWithLocalStore(store, first, () => emitXorOfAdds(body, () => { emitted += 1; }));
  emitWithLocalStore(store, second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("LocalStore reuses high-cost retained expressions through one local", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = highCostValue();
  const second = highCostValue();
  const store = new LocalStore(body);
  let emitted = 0;

  emitWithLocalStore(store, first, () => emitHighCostValue(body, () => { emitted += 1; }));
  emitWithLocalStore(store, second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("LocalStore retain reports whether it emitted local.set", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  let emitted = 0;

  const first = captureWithLocalStore(store, value, () => emitAdd(body, () => { emitted += 1; }));
  const second = captureWithLocalStore(store, value, unexpectedEmitter);

  strictEqual(first?.emitted, true);
  strictEqual(second?.emitted, false);
  strictEqual(second?.local, first?.local);
  emitWithLocalStore(store, value, unexpectedEmitter);
  body.end();

  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localGet]);
});

test("LocalStore retires invalidated locals before rematerializing", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const first = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (first === undefined) {
    throw new Error("expected first exit store");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const second = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (second === undefined) {
    throw new Error("expected second exit store");
  }

  body.end();

  strictEqual(first.local === second.local, false);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("LocalStore reuses non-escaped locals after invalidation", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const first = emitWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (first.local === undefined) {
    throw new Error("expected first cached local");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const second = emitWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (second.local === undefined) {
    throw new Error("expected second cached local");
  }

  body.end();

  strictEqual(second.local, first.local);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localTee]);
});

test("LocalStore retires locals that become escaped while available", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const first = emitWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (first.local === undefined) {
    throw new Error("expected first cached local");
  }

  const escaped = captureWithLocalStore(store, value, unexpectedEmitter);

  if (escaped === undefined) {
    throw new Error("expected escaped cached local");
  }

  strictEqual(escaped.local, first.local);
  strictEqual(escaped.emitted, false);

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const rematerialized = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (rematerialized === undefined) {
    throw new Error("expected rematerialized cached local");
  }

  body.end();

  strictEqual(rematerialized.local === first.local, false);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localSet]);
});

test("LocalStore reuses retired escaped locals after owners release", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const first = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (first === undefined) {
    throw new Error("expected first exit store");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");
  first.release();

  const second = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (second === undefined) {
    throw new Error("expected second exit store");
  }

  body.end();

  strictEqual(second.local, first.local);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("LocalStore retained handles fail on double release", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const captured = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  captured.release();

  throws(
    () => captured.release(),
    /JIT cached value handle was released more than once/
  );
});

test("LocalStore retained handles fail on retain after release", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const captured = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  captured.release();

  throws(
    () => captured.retain(),
    /JIT cached value handle was retained after release/
  );
});

test("LocalStore path stack underflow fails loudly", () => {
  const body = new WasmFunctionBodyEncoder();
  const store = new LocalStore(body);

  throws(
    () => store.leavePath(),
    /JIT value cache path stack underflow/
  );
});

test("LocalStore paths hide branch-local captures from sibling arms", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  let emitted = 0;

  store.enterPath(branchPath(0, 0, "taken"));
  const taken = captureWithLocalStore(store, value, () => emitAdd(body, () => { emitted += 1; }));
  store.leavePath();

  if (taken === undefined) {
    throw new Error("expected taken branch exit store");
  }

  store.enterPath(branchPath(0, 0, "notTaken"));
  const notTaken = captureWithLocalStore(store, value, () => emitAdd(body, () => { emitted += 1; }));
  store.leavePath();

  if (notTaken === undefined) {
    throw new Error("expected not-taken branch exit store");
  }

  body.end();

  strictEqual(taken.emitted, true);
  strictEqual(notTaken.emitted, true);
  strictEqual(taken.local === notTaken.local, false);
  strictEqual(emitted, 2);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("LocalStore paths preserve root values available before branch split", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  let emitted = 0;

  const preBranch = emitWithLocalStore(store, value, () => emitAdd(body, () => { emitted += 1; }));

  if (preBranch.local === undefined) {
    throw new Error("expected pre-branch cached local");
  }

  store.enterPath(branchPath(0, 0, "taken"));
  const taken = captureWithLocalStore(store, value, unexpectedEmitter);
  store.leavePath();

  store.enterPath(branchPath(0, 0, "notTaken"));
  const notTaken = captureWithLocalStore(store, value, unexpectedEmitter);
  store.leavePath();

  body.end();

  strictEqual(taken?.emitted, false);
  strictEqual(notTaken?.emitted, false);
  strictEqual(taken?.local, preBranch.local);
  strictEqual(notTaken?.local, preBranch.local);
  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee]);
});

test("LocalStore keeps parent path availability alive while child paths exit", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const parentPath = { kind: "path", id: "parent" } as const;
  const childPath = { kind: "path", id: "child" } as const;
  const siblingPath = { kind: "path", id: "sibling" } as const;
  const store = new LocalStore(body);
  let emitted = 0;

  store.enterPath(parentPath);
  const parent = captureWithLocalStore(store, value, () => emitAdd(body, () => { emitted += 1; }));

  store.enterPath(childPath);
  const child = captureWithLocalStore(store, value, unexpectedEmitter);
  store.leavePath();

  const parentAfterChild = captureWithLocalStore(store, value, unexpectedEmitter);

  if (parent === undefined || child === undefined || parentAfterChild === undefined) {
    throw new Error("expected parent path exit stores");
  }

  parent.release();
  child.release();
  parentAfterChild.release();
  store.leavePath();

  store.enterPath(siblingPath);
  const sibling = captureWithLocalStore(store, value, () => emitAdd(body, () => { emitted += 1; }));
  store.leavePath();

  if (sibling === undefined) {
    throw new Error("expected sibling path exit store");
  }

  body.end();

  strictEqual(parent.emitted, true);
  strictEqual(child.emitted, false);
  strictEqual(parentAfterChild.emitted, false);
  strictEqual(sibling.emitted, true);
  strictEqual(child.local, parent.local);
  strictEqual(parentAfterChild.local, parent.local);
  strictEqual(sibling.local, parent.local);
  strictEqual(emitted, 2);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("LocalStore reuses released branch-local locals after leaving path", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);

  store.enterPath(branchPath(0, 0, "taken"));
  const taken = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));
  store.leavePath();

  if (taken === undefined) {
    throw new Error("expected taken branch exit store");
  }

  taken.release();

  store.enterPath(branchPath(0, 0, "notTaken"));
  const notTaken = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));
  store.leavePath();

  if (notTaken === undefined) {
    throw new Error("expected not-taken branch exit store");
  }

  body.end();

  strictEqual(notTaken.local, taken.local);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("LocalStore keeps pinned exit-store locals out of reuse", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body);
  const valueCache = cacheRuntimeForStore(store);
  const captured = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (captured === undefined) {
    throw new Error("expected captured cached local");
  }

  const exitStores = captureExitStores({
    body,
    valueCache
  }, [{
    store: {
      target: { kind: "reg32", reg: "eax" },
      value
    },
    source: {
      kind: "capture",
      capture: storeClobberCapture(value)
    }
  }]);

  if (exitStores === undefined) {
    throw new Error("expected captured exit store");
  }

  captured.release();
  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const rematerialized = captureWithLocalStore(store, value, () => emitAdd(body, () => {}));

  if (rematerialized === undefined) {
    throw new Error("expected rematerialized cached local");
  }

  releaseExitStores(exitStores);
  body.end();

  strictEqual(rematerialized.local === captured.local, false);
});

function storeClobberCapture(value: Capture["value"]): Capture {
  return {
    value,
    at: { instructionIndex: 0, opIndex: 0, epoch: 0 },
    availability: rootPath(),
    consumers: [],
    reason: "storeClobber"
  };
}

test("LocalStore forgetWhere invalidates only matching values", () => {
  const body = new WasmFunctionBodyEncoder();
  const eax = addValue("eax", 1);
  const ebx = addValue("ebx", 1);
  const store = new LocalStore(body);
  let eaxEmits = 0;
  let ebxEmits = 0;

  emitWithLocalStore(store, eax, () => emitAdd(body, () => { eaxEmits += 1; }));
  emitWithLocalStore(store, ebx, () => emitAdd(body, () => { ebxEmits += 1; }));
  store.forgetWhere((value) =>
    value.kind === "value.binary" &&
    value.a.kind === "input" &&
    value.a.slot.kind === "reg32" &&
    value.a.slot.reg === "eax"
  );
  emitWithLocalStore(store, eax, () => emitAdd(body, () => { eaxEmits += 1; }));
  emitWithLocalStore(store, ebx, unexpectedEmitter);
  body.end();

  strictEqual(eaxEmits, 2);
  strictEqual(ebxEmits, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [
    wasmOpcode.localTee,
    wasmOpcode.localTee,
    wasmOpcode.localTee,
    wasmOpcode.localGet
  ]);
});
