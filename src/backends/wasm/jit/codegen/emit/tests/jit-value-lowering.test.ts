import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import {
  IR_ALU_FLAG_MASK,
  IR_ALU_FLAG_MASKS
} from "#x86/ir/model/flag-effects.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { cleanValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import {
  jitFlagConditionValue,
  jitFlagProducerValue,
  jitExtractBits,
  jitExtractMaskedBits,
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitLoadResultValue
} from "#backends/wasm/jit/ir/values/builders.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import type {
  JitArchitecturalSlot,
  JitValue
} from "#backends/wasm/jit/ir/values/types.js";
import {
  createValueEmitters,
  unavailableLoadResultEmitter,
  type InputEmitter,
  type ValueEmitContext
} from "#backends/wasm/jit/codegen/emit/values.js";
import type { Placement } from "#backends/wasm/jit/codegen/plan/effect-types.js";
import {
  emitInputSlot,
  emitInputSlotBits
} from "#backends/wasm/jit/codegen/emit/input-slots.js";
import {
  jitRegisterSlotAlias
} from "#backends/wasm/jit/ir/values/slots.js";
import {
  LocalStore,
  emitWithLocalStore,
  captureWithLocalStore,
  passthroughValueCache
} from "./value-local-store-test-helpers.js";

test("ValueEmitter lowers register bit insertion directly to Wasm", () => {
  const opcodes = emitSymbolicValue(
    jitInsertBits(jitInputReg32Value("eax"), c32(0x7f), 8, 8)
  );

  strictEqual(countOpcode(opcodes, wasmOpcode.localGet) >= 1, true);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And) >= 1, true);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Shl), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
});

test("ValueEmitter lowers every non-load-result JitValue kind", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const producer = jitFlagProducerValue("add", {
    left: eax,
    right: ebx,
    result: add(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASKS.CF | IR_ALU_FLAG_MASKS.ZF });
  const cases: readonly Readonly<{ kind: Exclude<JitValue["kind"], "loadResult">; value: JitValue }>[] = [
    { kind: "const", value: c32(7) },
    { kind: "input", value: eax },
    { kind: "value.binary", value: add(eax, ebx) },
    { kind: "value.unary", value: extend8s(eax) },
    { kind: "value.select", value: select(eax, ebx, c32(0)) },
    { kind: "extractBits", value: jitExtractBits(eax, 8, 8) },
    { kind: "insertBits", value: jitInsertBits(eax, ebx, 8, 8) },
    { kind: "extractMaskedBits", value: jitExtractMaskedBits(eax, 0xff00) },
    { kind: "insertMaskedBits", value: jitInsertMaskedBits(eax, ebx, 0xff00) },
    { kind: "flagProducer", value: producer },
    { kind: "flagCondition", value: jitFlagConditionValue(jitInputAluFlagsValue(), "E") }
  ];

  for (const valueCase of cases) {
    strictEqual(valueCase.value.kind, valueCase.kind);
    strictEqual(emitSymbolicValue(valueCase.value).length > 0, true, valueCase.kind);
  }
});

test("ValueEmitter lowers load-result values through LoadResultEmitter", () => {
  const body = new WasmFunctionBodyEncoder();
  const loadResult = jitLoadResultValue(0, "i32");
  let emitted = false;

  const valueWidth = createValueEmitters({
    ...bodyContext(body),
    loadResults: {
      emit: (value) => {
        strictEqual(value, loadResult);
        emitted = true;
        body.i32Const(0x1234);
        return cleanValueWidth(32);
      }
    }
  }).at(testPlacement()).emit(loadResult);
  body.end();

  strictEqual(emitted, true);
  strictEqual(valueWidth.cleanWidth, 32);
  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Const), 1);
});

test("ValueEmitter fails load-result values when unavailable", () => {
  const body = new WasmFunctionBodyEncoder();
  const loadResult = jitLoadResultValue(0, "i32");

  throws(
    () => createValueEmitters(bodyContext(body)).at(testPlacement()).emit(loadResult),
    /load-result JIT value is not available for lowering: 0/
  );
});

test("ValueEmitter lowers shl binary values to Wasm shift-left", () => {
  const opcodes = emitSymbolicValue(shl(jitInputReg32Value("ecx"), c32(2)));

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Shl), 1);
});

test("ValueEmitter lowers symbolic flag producers with existing flag-bit logic", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const producer = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: sub(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASK });
  const opcodes = emitSymbolicValue(producer);

  strictEqual(countOpcode(opcodes, wasmOpcode.i32LtU) >= 1, true);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Popcnt) >= 1, true);
});

test("ValueEmitter reports flag producer width from its mask", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const producer = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: sub(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASK });
  const { valueWidth } = emitSymbolicValueResult(producer);

  strictEqual(valueWidth.logicalWidth, cleanWidthForMask(IR_ALU_FLAG_MASK));
  strictEqual(valueWidth.cleanWidth, cleanWidthForMask(IR_ALU_FLAG_MASK));
});

test("ValueEmitter does not bypass a selected input dependency for direct slice lowering", () => {
  const body = new WasmFunctionBodyEncoder();
  const root = jitInputReg32Value("eax");
  const context = bodyContext(body);
  let selectedRootUseCount = 0;

  createValueEmitters({
    ...context,
    cache: passthroughValueCache({
      emitForUse: (_at, value, emitter) => {
        if (value.kind === "input") {
          selectedRootUseCount += 1;
        }

        return { valueWidth: emitter() };
      },
      canInline: (_at, value) => value.kind !== "input"
    }),
    inputs: {
      ...context.inputs,
      emitBits: () => {
        throw new Error("direct input bits should not bypass selected input dependency");
      }
    }
  }).at(testPlacement()).emit(jitExtractBits(root, 8, 8));
  body.end();

  strictEqual(selectedRootUseCount, 1);
});

test("ValueEmitter does not bypass a selected slice root for signed direct lowering", () => {
  const body = new WasmFunctionBodyEncoder();
  const root = jitExtractBits(jitInputReg32Value("eax"), 0, 8);
  const context = bodyContext(body);
  let selectedRootUseCount = 0;

  createValueEmitters({
    ...context,
    cache: passthroughValueCache({
      emitForUse: (_at, value, emitter) => {
        if (value.kind === "extractBits") {
          selectedRootUseCount += 1;
          body.i32Const(0x7f);
          return { valueWidth: cleanValueWidth(8) };
        }

        return { valueWidth: emitter() };
      },
      canInline: (_at, value) => value.kind !== "extractBits"
    }),
    inputs: {
      ...context.inputs,
      emitBits: () => {
        throw new Error("direct input bits should not bypass selected slice root");
      }
    }
  }).at(testPlacement()).emit(extend8s(root));
  body.end();

  strictEqual(selectedRootUseCount, 1);
  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Extend8S), 1);
});

test("ValueEmitter returns signed direct slices without a second sign extension", () => {
  const opcodes = emitSymbolicValueResult({
    kind: "value.unary",
    type: "i32",
    operator: "extend8_s",
    value: jitExtractBits(jitInputReg32Value("eax"), 0, 8)
  }, {
    emitInputBits: (body) => {
      body.i32Const(0x7f);
      return cleanValueWidth(32);
    }
  }).opcodes;

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Extend8S), 0);
});

test("ValueEmitter lowers signed input slot slices to signed state loads", () => {
  const byteOpcodes = emitSymbolicValueResult(extend8s(jitExtractBits(jitInputReg32Value("eax"), 0, 8)), {
    emitInputBits: emitInputSlotBits
  }).opcodes;
  const wordOpcodes = emitSymbolicValueResult(extend16s(jitExtractBits(jitInputReg32Value("eax"), 0, 16)), {
    emitInputBits: emitInputSlotBits
  }).opcodes;

  strictEqual(countOpcode(byteOpcodes, wasmOpcode.i32Load8S), 1);
  strictEqual(countOpcode(byteOpcodes, wasmOpcode.i32Extend8S), 0);
  strictEqual(countOpcode(wordOpcodes, wasmOpcode.i32Load16S), 1);
  strictEqual(countOpcode(wordOpcodes, wasmOpcode.i32Extend16S), 0);
});

test("emitInputSlot lowers IR register alias slots to narrow state loads", () => {
  const body = new WasmFunctionBodyEncoder();

  const wordWidth = emitInputSlot(body, { kind: "reg16", reg: "ax" });
  const byteWidth = emitInputSlot(body, { kind: "reg8", reg: "ah" });
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(wordWidth.cleanWidth, 16);
  strictEqual(byteWidth.cleanWidth, 8);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load16U), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Load8U), 1);
});

test("emitInputSlotBits rejects slices that extend past a register slot", () => {
  const body = new WasmFunctionBodyEncoder();
  const valueWidth = emitInputSlotBits(body, { kind: "reg32", reg: "eax" }, 24, 16, false);

  body.end();

  strictEqual(valueWidth, undefined);
  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load16U), 0);
});

test("emitInputSlotBits rejects non-register slots for slice access", () => {
  const body = new WasmFunctionBodyEncoder();
  const valueWidth = emitInputSlotBits(body, { kind: "aluFlags" }, 0, 8, false);

  body.end();

  strictEqual(valueWidth, undefined);
  strictEqual(countOpcode(wasmBodyOpcodes(body.encode()), wasmOpcode.i32Load8U), 0);
});

test("ValueEmitter lowers flag conditions from producer inputs when possible", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const producer = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: sub(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASK });
  const opcodes = emitSymbolicValue(jitFlagConditionValue(producer, "E"));

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Eqz), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 0);
});

test("ValueEmitter routes flag conditions through inserted masked flag bits", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const producer = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: sub(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASKS.ZF });
  const flags = jitInsertMaskedBits(jitInputAluFlagsValue(), producer, IR_ALU_FLAG_MASKS.ZF);
  const opcodes = emitSymbolicValue(jitFlagConditionValue(flags, "E"));

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 0);
});

test("ValueEmitter routes flag conditions through preserved masked flag bits", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const producer = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: sub(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASKS.ZF });
  const flags = jitInsertMaskedBits(jitInputAluFlagsValue(), producer, IR_ALU_FLAG_MASKS.ZF);
  const opcodes = emitSymbolicValue(jitFlagConditionValue(flags, "B"));

  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32LtU), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 0);
});

test("ValueEmitter routes split flag conditions through nested masked producers", () => {
  const eax = jitInputReg32Value("eax");
  const ebx = jitInputReg32Value("ebx");
  const ecx = jitInputReg32Value("ecx");
  const carryProducer = jitFlagProducerValue("sub", {
    left: eax,
    right: ebx,
    result: sub(eax, ebx)
  }, { mask: IR_ALU_FLAG_MASKS.CF });
  const zeroProducer = jitFlagProducerValue("logic", {
    result: ecx
  }, { mask: IR_ALU_FLAG_MASKS.ZF });
  const flags = jitInsertMaskedBits(
    jitInsertMaskedBits(jitInputAluFlagsValue(), carryProducer, IR_ALU_FLAG_MASKS.CF),
    zeroProducer,
    IR_ALU_FLAG_MASKS.ZF
  );
  const opcodes = emitSymbolicValue(jitFlagConditionValue(flags, "BE"));

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32LtU), 1);
});

test("ValueEmitter lowers flag conditions from symbolic aluFlags values", () => {
  const opcodes = emitSymbolicValue(jitFlagConditionValue(jitInputAluFlagsValue(), "E"));

  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Eqz), 2);
});

test("LocalStore cache keys support canonical symbolic nodes", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = jitInsertBits(jitInputReg32Value("eax"), add(jitInputReg32Value("ebx"), c32(1)), 0, 8);
  const second = jitInsertBits(jitInputReg32Value("eax"), add(jitInputReg32Value("ebx"), c32(1)), 0, 8);
  const store = new LocalStore(body);
  let emitted = 0;

  emitWithLocalStore(store, first, () => emitAdd(body, () => { emitted += 1; }));
  emitWithLocalStore(store, second, unexpectedEmitter);
  body.end();

  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("ValueEmitter lowers load-result values through retained locals", () => {
  const body = new WasmFunctionBodyEncoder();
  const loadResult = jitLoadResultValue(0, "i32");
  const store = new LocalStore(body);
  const context = bodyContext(body);
  const captured = captureWithLocalStore(store, loadResult, () => {
    body.i32Const(0x1234);
    return cleanValueWidth(32);
  });

  if (captured === undefined) {
    throw new Error("expected load-result value capture");
  }

  const valueWidth = createValueEmitters({
    ...context,
    cache: {
      emitForUse: (_at, value, emitter) => emitWithLocalStore(store, value, emitter),
      retain: (value) => store.retainAvailable(value),
      capture: (capture, emitter) => captureWithLocalStore(store, capture.value, emitter),
      define: (_at, value, emitter) => captureWithLocalStore(store, value, emitter),
      canInline: () => true
    },
    loadResults: { emit: () => unexpectedEmitter() }
  }).at(testPlacement()).emit(loadResult);

  body.end();

  strictEqual(valueWidth.cleanWidth, 32);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localGet]);
});

test("ValueEmitter.emitInline suppresses only the root cache use", () => {
  const body = new WasmFunctionBodyEncoder();
  const child = add(jitInputReg32Value("eax"), c32(1));
  const root = add(child, c32(2));
  const context = bodyContext(body);
  let rootCacheUseCount = 0;
  let childCacheUseCount = 0;

  createValueEmitters({
    ...context,
    cache: passthroughValueCache({
      emitForUse: (_at, value, emitter) => {
        if (valuesEqual(value, root)) {
          rootCacheUseCount += 1;
        }

        if (valuesEqual(value, child)) {
          childCacheUseCount += 1;
          body.i32Const(0x1234);
          return { valueWidth: cleanValueWidth(32) };
        }

        return { valueWidth: emitter() };
      }
    })
  }).at(testPlacement()).emitInline(root);
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(rootCacheUseCount, 0);
  strictEqual(childCacheUseCount, 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Add), 1);
});

type EmitSymbolicValueOptions = Readonly<{
  emitInputBits?(
    body: WasmFunctionBodyEncoder,
    slot: JitArchitecturalSlot,
    bitOffset: number,
    width: 8 | 16 | 32,
    signed: boolean
  ): ValueWidth | undefined;
}>;

function emitSymbolicValue(value: JitValue): readonly number[] {
  return emitSymbolicValueResult(value).opcodes;
}

function emitSymbolicValueResult(
  value: JitValue,
  options: EmitSymbolicValueOptions = {}
): Readonly<{ opcodes: readonly number[]; valueWidth: ValueWidth }> {
  const body = new WasmFunctionBodyEncoder();
  const context = bodyContext(body);
  const valueWidth = createValueEmitters({
    ...context,
    inputs: testInputEmitter(body, context.inputs, options)
  }).at(testPlacement()).emit(value);

  body.end();
  return { opcodes: wasmBodyOpcodes(body.encode()), valueWidth };
}

function testInputEmitter(
  body: WasmFunctionBodyEncoder,
  inputs: InputEmitter,
  options: EmitSymbolicValueOptions
): InputEmitter {
  if (options.emitInputBits === undefined) {
    return inputs;
  }

  return {
    ...inputs,
    emitBits: (slot, bitOffset, width, signed) =>
      options.emitInputBits!(body, slot, bitOffset, width, signed)
  };
}

function bodyContext(body: WasmFunctionBodyEncoder): ValueEmitContext {
  const cache = passthroughValueCache({});
  const locals = {
    eax: body.addLocal(wasmValueType.i32),
    ebx: body.addLocal(wasmValueType.i32),
    ecx: body.addLocal(wasmValueType.i32),
    edx: body.addLocal(wasmValueType.i32),
    esi: body.addLocal(wasmValueType.i32),
    edi: body.addLocal(wasmValueType.i32),
    esp: body.addLocal(wasmValueType.i32),
    ebp: body.addLocal(wasmValueType.i32),
    aluFlags: body.addLocal(wasmValueType.i32)
  };

  return {
    body,
    cache,
    scope: cache,
    inputs: {
      emit: (slot: JitArchitecturalSlot) => {
        if (slot.kind === "aluFlags") {
          body.localGet(locals.aluFlags);
          return cleanValueWidth(32);
        }

        const alias = jitRegisterSlotAlias(slot);

        body.localGet(locals[alias.base]);
        if (alias.bitOffset !== 0) {
          body.i32Const(alias.bitOffset);
          body.i32ShrU();
        }
        if (alias.width !== 32) {
          body.i32Const(alias.width === 16 ? 0xffff : 0xff);
          body.i32And();
        }
        return cleanValueWidth(alias.width);
      }
    },
    loadResults: unavailableLoadResultEmitter()
  };
}

function testPlacement(): Placement {
  return {
    opIndex: 0,
    epoch: 0
  };
}

function c32(value: number): JitValue {
  return { kind: "const", type: "i32", value };
}

function add(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "add", a, b };
}

function shl(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "shl", a, b };
}

function sub(a: JitValue, b: JitValue): JitValue {
  return { kind: "value.binary", type: "i32", operator: "sub", a, b };
}

function select(condition: JitValue, whenTrue: JitValue, whenFalse: JitValue): JitValue {
  return { kind: "value.select", type: "i32", condition, whenTrue, whenFalse };
}

function extend8s(value: JitValue): JitValue {
  return { kind: "value.unary", type: "i32", operator: "extend8_s", value };
}

function extend16s(value: JitValue): JitValue {
  return { kind: "value.unary", type: "i32", operator: "extend16_s", value };
}

function emitAdd(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(10).i32Const(1).i32Add();
  return cleanValueWidth(32);
}

function unexpectedEmitter(): ValueWidth {
  throw new Error("unexpected value emission");
}

function localOpcodes(opcodes: readonly number[]): readonly number[] {
  return opcodes.filter((opcode) =>
    opcode === wasmOpcode.localGet ||
    opcode === wasmOpcode.localSet ||
    opcode === wasmOpcode.localTee
  );
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
}

function cleanWidthForMask(mask: number): 8 | 16 | 32 {
  const normalized = mask >>> 0;

  if (normalized <= 0xff) {
    return 8;
  }

  if (normalized <= 0xffff) {
    return 16;
  }

  return 32;
}
