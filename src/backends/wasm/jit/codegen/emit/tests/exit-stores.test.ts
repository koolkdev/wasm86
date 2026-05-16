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
  LocalStore,
  captureExitStores,
  emitExitStores,
  releaseExitStores,
  buildBlock,
  encodeJitBlock,
  addValue,
  useCounts,
  cacheRuntimeForStore,
  countOpcode,
} from "./value-local-store-test-helpers.js";
import { throws } from "node:assert";
import { rootPath } from "#backends/wasm/jit/analysis/paths.js";
import type { Capture } from "#backends/wasm/jit/codegen/plan/captures.js";

test("JIT exit stores require planned cache captures for aluFlags source clobbers", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = jitInputAluFlagsValue();

  throws(
    () => captureExitStores({
      body
    }, [
      {
        store: {
          target: { kind: "aluFlags" },
          value: { kind: "const", type: "i32", value: 0 }
        },
        source: { kind: "inline" }
      },
      {
        store: {
          target: { kind: "reg32", reg: "eax" },
          value
        },
        source: { kind: "capture", capture: storeClobberCapture(value) }
      }
    ]),
    /JIT exit-store source capture was not available in the value cache/
  );
});

test("JIT exit stores require planned cache captures for aliased register source clobbers", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = jitInputReg32Value("eax");

  throws(
    () => captureExitStores({
      body
    }, [
      {
        store: {
          target: { kind: "reg8", reg: "ah" },
          value: { kind: "const", type: "i32", value: 0x12 }
        },
        source: { kind: "inline" }
      },
      {
        store: {
          target: { kind: "reg32", reg: "ebx" },
          value
        },
        source: { kind: "capture", capture: storeClobberCapture(value) }
      }
    ]),
    /JIT exit-store source capture was not available in the value cache/
  );
});

test("JIT flag exit stores lower planned sources through value cache", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const store = new LocalStore(body, useCounts([{ value, useCount: 2 }]));
  const valueCache = cacheRuntimeForStore(store);
  const captured = captureExitStores({
    body,
    valueCache
  }, [{
    store: {
      target: { kind: "aluFlags" },
      value
    },
    source: { kind: "inline" }
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

function storeClobberCapture(value: Capture["value"]): Capture {
  return {
    value,
    at: { instructionIndex: 0, opIndex: 0, epoch: 0 },
    availability: rootPath(),
    consumers: [],
    reason: "storeClobber"
  };
}
