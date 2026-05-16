import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  wasmOpcode,
  stateOffset,
  ok,
  decodeBytes,
  startAddress,
  extractOnlyWasmFunctionBody,
  wasmBodyMemoryAccesses,
  wasmBodyOpcodes,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  JitValueLocalStore,
  captureExitStores,
  emitExitStores,
  releaseExitStores,
  buildBlock,
  encodeJitBlock,
  addValue,
  useCounts,
  cacheRuntimeForStore,
  localOpcodes,
  countOpcode,
} from "./value-local-store-test-helpers.js";
test("JIT exit stores capture aluFlags sources before overwriting flags", () => {
  const body = new WasmFunctionBodyEncoder();
  const captured = captureExitStores({
    body
  }, [
    {
      target: { kind: "aluFlags" },
      value: { kind: "const", type: "i32", value: 0 }
    },
    {
      target: { kind: "reg32", reg: "eax" },
      value: jitInputAluFlagsValue(),
      sourceCapture: {
        kind: "beforeStores",
        reason: "targetClobber"
      }
    }
  ]);

  if (captured === undefined) {
    throw new Error("expected captured exit stores");
  }

  emitExitStores({ body }, captured);
  releaseExitStores(captured);
  body.end();

  const encoded = body.encode();

  deepStrictEqual(localOpcodes(wasmBodyOpcodes(encoded)), [wasmOpcode.localSet, wasmOpcode.localGet]);
  deepStrictEqual(
    wasmBodyMemoryAccesses(encoded)
      .filter((access) =>
        access.offset === stateOffset.aluFlags ||
        access.offset === stateOffset.eax
      )
      .map(({ opcode, offset }) => ({ opcode, offset })),
    [
      { opcode: wasmOpcode.i32Load, offset: stateOffset.aluFlags },
      { opcode: wasmOpcode.i32Store, offset: stateOffset.aluFlags },
      { opcode: wasmOpcode.i32Store, offset: stateOffset.eax }
    ]
  );
});

test("JIT exit stores capture register sources before overwriting aliased register targets", () => {
  const body = new WasmFunctionBodyEncoder();
  const captured = captureExitStores({
    body
  }, [
    {
      target: { kind: "reg8", reg: "ah" },
      value: { kind: "const", type: "i32", value: 0x12 }
    },
    {
      target: { kind: "reg32", reg: "ebx" },
      value: jitInputReg32Value("eax"),
      sourceCapture: {
        kind: "beforeStores",
        reason: "targetClobber"
      }
    }
  ]);

  if (captured === undefined) {
    throw new Error("expected captured exit stores");
  }

  emitExitStores({ body }, captured);
  releaseExitStores(captured);
  body.end();

  const encoded = body.encode();

  deepStrictEqual(localOpcodes(wasmBodyOpcodes(encoded)), [wasmOpcode.localSet, wasmOpcode.localGet]);
  deepStrictEqual(
    wasmBodyMemoryAccesses(encoded)
      .filter((access) =>
        access.offset === stateOffset.eax ||
        access.offset === stateOffset.eax + 1 ||
        access.offset === stateOffset.ebx
      )
      .map(({ opcode, offset }) => ({ opcode, offset })),
    [
      { opcode: wasmOpcode.i32Load, offset: stateOffset.eax },
      { opcode: wasmOpcode.i32Store8, offset: stateOffset.eax + 1 },
      { opcode: wasmOpcode.i32Store, offset: stateOffset.ebx }
    ]
  );
});

test("JIT flag exit stores lower planned sources through value cache", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new JitValueLocalStore(body, useCounts([{ value, useCount: 2 }]));
  const valueCache = cacheRuntimeForStore(store);
  const captured = captureExitStores({
    body,
    valueCache
  }, [{
    target: { kind: "aluFlags" },
    value
  }]);

  if (captured === undefined) {
    throw new Error("expected captured flag exit store");
  }

  emitExitStores({
    body,
    valueCache
  }, captured);
  releaseExitStores(captured);
  body.end();

  const encoded = body.encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Add), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localGet) > 0, true);
  deepStrictEqual(
    wasmBodyMemoryAccesses(encoded)
      .filter((access) => access.opcode === wasmOpcode.i32Store)
      .map(({ opcode, offset }) => ({ opcode, offset })),
    [{ opcode: wasmOpcode.i32Store, offset: stateOffset.aluFlags }]
  );
});

test("JIT register exit store reuses pure NEG planned values", () => {
  const mov = ok(decodeBytes([0xb8, 0x01, 0x00, 0x00, 0x00], startAddress));
  const neg = ok(decodeBytes([0xf7, 0xd8], mov.nextEip));
  const trap = ok(decodeBytes([0xcd, 0x2e], neg.nextEip));
  const body = extractOnlyWasmFunctionBody(encodeJitBlock([buildBlock([mov, neg, trap])]));
  const opcodes = wasmBodyOpcodes(body);

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Sub), 1);
});
