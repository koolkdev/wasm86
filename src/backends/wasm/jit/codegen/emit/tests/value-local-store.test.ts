import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  wasmOpcode,
  wasmBodyLocalCount,
  wasmBodyOpcodes,
  JitValueLocalStore,
  captureJitExitMaterializationStores,
  releaseJitExitMaterializationStores,
  addValue,
  highCostValue,
  jitInputReg32Value,
  useCounts,
  emitAdd,
  emitXorOfAdds,
  emitHighCostValue,
  emitConst,
  emitExtend8,
  unexpectedEmitter,
  branchValuePathScope,
  localOpcodes,
  countOpcode,
  type JitValue,
  type JitValueCacheRuntime,
} from "./value-local-store-test-helpers.js";
test("JitValueLocalStore reuses one local for equal non-trivial values", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = addValue("eax", 1);
  const second = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitAdd(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Add), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JitValueLocalStore reuses structurally equal binary expressions", () => {
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
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitXorOfAdds(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JitValueLocalStore reuses high-cost retained expressions through one local", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = highCostValue();
  const second = highCostValue();
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitHighCostValue(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
  deepStrictEqual(localOpcodes(opcodes), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("JitValueLocalStore does not cache unselected high-cost retained expressions", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = highCostValue();
  const store = new JitValueLocalStore(body, useCounts([]));
  let emitted = 0;

  store.emitForUse(value, () => emitHighCostValue(body, () => { emitted += 1; }));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 1);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
  deepStrictEqual(localOpcodes(opcodes), []);
});

test("JitValueLocalStore does not cache unselected constants", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = { kind: "const", type: "i32", value: 7 } as const satisfies JitValue;
  const store = new JitValueLocalStore(body, useCounts([]));
  let emitted = 0;

  store.emitForUse(value, () => emitConst(body, 7, () => { emitted += 1; }));
  store.emitForUse(value, () => emitConst(body, 7, () => { emitted += 1; }));
  store.emitForUse(value, () => emitConst(body, 7, () => { emitted += 1; }));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 3);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Const), 3);
  deepStrictEqual(localOpcodes(opcodes), []);
});

test("JitValueLocalStore does not cache unselected tied-cost expressions", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = {
    kind: "value.unary",
    type: "i32",
    operator: "extend8_s",
    value: jitInputReg32Value("eax")
  } as const satisfies JitValue;
  const store = new JitValueLocalStore(body, useCounts([]));
  let emitted = 0;

  store.emitForUse(value, () => emitExtend8(body, () => { emitted += 1; }));
  store.emitForUse(value, () => emitExtend8(body, () => { emitted += 1; }));
  body.end();

  strictEqual(emitted, 2);
  strictEqual(wasmBodyLocalCount(body.encode()), 0);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), []);
});

test("JitValueLocalStore captureForReuse reports whether it emitted local.set", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 2 }]));
  let emitted = 0;

  const first = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));
  const second = store.captureForReuse(value, unexpectedEmitter);

  strictEqual(first?.emitted, true);
  strictEqual(second?.emitted, false);
  strictEqual(second?.local, first?.local);
  store.emitForUse(value, unexpectedEmitter);
  body.end();

  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localGet]);
});

test("JitValueLocalStore retires invalidated locals before rematerializing", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (first === undefined) {
    throw new Error("expected first materialization");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const second = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (second === undefined) {
    throw new Error("expected second materialization");
  }

  body.end();

  strictEqual(first.local === second.local, false);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore reuses non-escaped locals after invalidation", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.emitForUseWithLocal(value, () => emitAdd(body, () => {}));

  if (first.local === undefined) {
    throw new Error("expected first cached local");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const second = store.emitForUseWithLocal(value, () => emitAdd(body, () => {}));

  if (second.local === undefined) {
    throw new Error("expected second cached local");
  }

  body.end();

  strictEqual(second.local, first.local);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localTee]);
});

test("JitValueLocalStore retires locals that become escaped while available", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.emitForUseWithLocal(value, () => emitAdd(body, () => {}));

  if (first.local === undefined) {
    throw new Error("expected first cached local");
  }

  const escaped = store.captureForReuse(value, unexpectedEmitter);

  if (escaped === undefined) {
    throw new Error("expected escaped cached local");
  }

  strictEqual(escaped.local, first.local);
  strictEqual(escaped.emitted, false);

  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const rematerialized = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (rematerialized === undefined) {
    throw new Error("expected rematerialized cached local");
  }

  body.end();

  strictEqual(rematerialized.local === first.local, false);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localSet]);
});

test("JitValueLocalStore reuses retired escaped locals after owners release", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const first = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (first === undefined) {
    throw new Error("expected first materialization");
  }

  store.forgetWhere((candidate) => candidate.kind === "value.binary");
  first.release();

  const second = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (second === undefined) {
    throw new Error("expected second materialization");
  }

  body.end();

  strictEqual(second.local, first.local);
  strictEqual(wasmBodyLocalCount(body.encode()), 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore path scopes hide branch-local captures from sibling arms", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  let emitted = 0;

  store.enterPathScope(branchValuePathScope(0, 0, "taken"));
  const taken = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));
  store.leavePathScope();

  if (taken === undefined) {
    throw new Error("expected taken branch materialization");
  }

  store.enterPathScope(branchValuePathScope(0, 0, "notTaken"));
  const notTaken = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));
  store.leavePathScope();

  if (notTaken === undefined) {
    throw new Error("expected not-taken branch materialization");
  }

  body.end();

  strictEqual(taken.emitted, true);
  strictEqual(notTaken.emitted, true);
  strictEqual(taken.local === notTaken.local, false);
  strictEqual(emitted, 2);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore path scopes preserve root values available before branch split", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  let emitted = 0;

  const preBranch = store.emitForUseWithLocal(value, () => emitAdd(body, () => { emitted += 1; }));

  if (preBranch.local === undefined) {
    throw new Error("expected pre-branch cached local");
  }

  store.enterPathScope(branchValuePathScope(0, 0, "taken"));
  const taken = store.captureForReuse(value, unexpectedEmitter);
  store.leavePathScope();

  store.enterPathScope(branchValuePathScope(0, 0, "notTaken"));
  const notTaken = store.captureForReuse(value, unexpectedEmitter);
  store.leavePathScope();

  body.end();

  strictEqual(taken?.emitted, false);
  strictEqual(notTaken?.emitted, false);
  strictEqual(taken?.local, preBranch.local);
  strictEqual(notTaken?.local, preBranch.local);
  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee]);
});

test("JitValueLocalStore keeps parent path availability alive while child paths exit", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const parentScope = { kind: "path", id: "parent" } as const;
  const childScope = { kind: "path", id: "child" } as const;
  const siblingScope = { kind: "path", id: "sibling" } as const;
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  let emitted = 0;

  store.enterPathScope(parentScope);
  const parent = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));

  store.enterPathScope(childScope);
  const child = store.captureForReuse(value, unexpectedEmitter);
  store.leavePathScope();

  const parentAfterChild = store.captureForReuse(value, unexpectedEmitter);

  if (parent === undefined || child === undefined || parentAfterChild === undefined) {
    throw new Error("expected parent path materializations");
  }

  parent.release();
  child.release();
  parentAfterChild.release();
  store.leavePathScope();

  store.enterPathScope(siblingScope);
  const sibling = store.captureForReuse(value, () => emitAdd(body, () => { emitted += 1; }));
  store.leavePathScope();

  if (sibling === undefined) {
    throw new Error("expected sibling path materialization");
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

test("JitValueLocalStore reuses released branch-local locals after leaving path scope", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));

  store.enterPathScope(branchValuePathScope(0, 0, "taken"));
  const taken = store.captureForReuse(value, () => emitAdd(body, () => {}));
  store.leavePathScope();

  if (taken === undefined) {
    throw new Error("expected taken branch materialization");
  }

  taken.release();

  store.enterPathScope(branchValuePathScope(0, 0, "notTaken"));
  const notTaken = store.captureForReuse(value, () => emitAdd(body, () => {}));
  store.leavePathScope();

  if (notTaken === undefined) {
    throw new Error("expected not-taken branch materialization");
  }

  body.end();

  strictEqual(notTaken.local, taken.local);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localSet]);
});

test("JitValueLocalStore keeps pinned exit-store locals out of reuse", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 4 }]));
  const valueCache = {
    captureForReuse: (cachedValue, emitter) => store.captureForReuse(cachedValue, emitter)
  } as JitValueCacheRuntime;
  const captured = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (captured === undefined) {
    throw new Error("expected captured cached local");
  }

  const exitStores = captureJitExitMaterializationStores({
    body,
    valueCache
  }, [{
    target: { kind: "reg32", reg: "eax" },
    value
  }]);

  if (exitStores === undefined) {
    throw new Error("expected captured exit store");
  }

  captured.release();
  store.forgetWhere((candidate) => candidate.kind === "value.binary");

  const rematerialized = store.captureForReuse(value, () => emitAdd(body, () => {}));

  if (rematerialized === undefined) {
    throw new Error("expected rematerialized cached local");
  }

  releaseJitExitMaterializationStores(exitStores);
  body.end();

  strictEqual(rematerialized.local === captured.local, false);
});

test("JitValueLocalStore forgetWhere invalidates only matching values", () => {
  const body = new WasmFunctionBodyEncoder();
  const eax = addValue("eax", 1);
  const ebx = addValue("ebx", 1);
  const store = new JitValueLocalStore(body, useCounts([
    { value: eax, useCount: 2 },
    { value: ebx, useCount: 2 }
  ]));
  let eaxEmits = 0;
  let ebxEmits = 0;

  store.emitForUse(eax, () => emitAdd(body, () => { eaxEmits += 1; }));
  store.emitForUse(ebx, () => emitAdd(body, () => { ebxEmits += 1; }));
  store.forgetWhere((value) =>
    value.kind === "value.binary" &&
    value.a.kind === "input" &&
    value.a.slot.kind === "reg32" &&
    value.a.slot.reg === "eax"
  );
  store.emitForUse(eax, () => emitAdd(body, () => { eaxEmits += 1; }));
  store.emitForUse(ebx, unexpectedEmitter);
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
