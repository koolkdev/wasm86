import { deepStrictEqual, strictEqual } from "node:assert";
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
  jitInputAluFlagsValue,
  jitInputReg32Value,
  jitInsertBits,
  jitInsertMaskedBits,
  jitProducedValue,
  type JitArchitecturalSlot,
  type JitValue
} from "#backends/wasm/jit/ir/values.js";
import { emitJitValue } from "#backends/wasm/jit/codegen/emit/jit-values.js";
import {
  JitValueLocalStore,
  type JitValueUseCount
} from "#backends/wasm/jit/codegen/emit/value-local-store.js";

test("emitJitValue lowers register bit insertion directly to Wasm", () => {
  const opcodes = emitSymbolicValue(
    jitInsertBits(jitInputReg32Value("eax"), c32(0x7f), 8, 8)
  );

  strictEqual(countOpcode(opcodes, wasmOpcode.localGet) >= 1, true);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And) >= 1, true);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Shl), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 1);
});

test("emitJitValue lowers shl binary values to Wasm shift-left", () => {
  const opcodes = emitSymbolicValue(shl(jitInputReg32Value("ecx"), c32(2)));

  strictEqual(countOpcode(opcodes, wasmOpcode.i32Shl), 1);
});

test("emitJitValue lowers symbolic flag producers with existing flag-bit logic", () => {
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

test("emitJitValue reports flag producer width from its mask", () => {
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

test("emitJitValue lowers flag conditions from producer inputs when possible", () => {
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

test("emitJitValue routes flag conditions through inserted masked flag bits", () => {
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

test("emitJitValue routes flag conditions through preserved masked flag bits", () => {
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

test("emitJitValue routes split flag conditions through nested masked producers", () => {
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

test("emitJitValue lowers flag conditions from symbolic aluFlags values", () => {
  const opcodes = emitSymbolicValue(jitFlagConditionValue(jitInputAluFlagsValue(), "E"));

  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32And), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Eqz), 2);
});

test("JitValueLocalStore cache keys support canonical symbolic nodes", () => {
  const body = new WasmFunctionBodyEncoder();
  const first = jitInsertBits(jitInputReg32Value("eax"), add(jitInputReg32Value("ebx"), c32(1)), 0, 8);
  const second = jitInsertBits(jitInputReg32Value("eax"), add(jitInputReg32Value("ebx"), c32(1)), 0, 8);
  const store = new JitValueLocalStore(body, useCounts([{ value: first, useCount: 2 }]));
  let emitted = 0;

  store.emitForUse(first, () => emitAdd(body, () => { emitted += 1; }));
  store.emitForUse(second, unexpectedEmitter);
  body.end();

  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localTee, wasmOpcode.localGet]);
});

test("emitJitValue lowers produced values through retained locals", () => {
  const body = new WasmFunctionBodyEncoder();
  const produced = jitProducedValue("load#0:0:1", "i32");
  const store = new JitValueLocalStore(body, useCounts([{ value: produced, useCount: 1 }]));
  const captured = store.captureForReuse(produced, () => {
    body.i32Const(0x1234);
    return cleanValueWidth(32);
  });

  if (captured === undefined) {
    throw new Error("expected produced value capture");
  }

  const valueWidth = emitJitValue({
    ...bodyContext(body),
    valueCache: {
      emitForUse: (_value, emitter) => emitter(),
      emitJitValueForUse: (value, emitter) => store.emitForUseWithLocal(value, emitter),
      captureJitValueForReuse: (value, emitter) => store.captureForReuse(value, emitter),
      beginInstruction: () => {},
      notifyWrite: () => {},
      captureForReuse: () => undefined,
      jitValueForExpression: () => undefined,
      jitValueForValueRef: () => undefined
    },
    emitProduced: () => unexpectedEmitter()
  }, produced);

  body.end();

  strictEqual(valueWidth.cleanWidth, 32);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localGet]);
});

function emitSymbolicValue(value: JitValue): readonly number[] {
  return emitSymbolicValueResult(value).opcodes;
}

function emitSymbolicValueResult(value: JitValue): Readonly<{ opcodes: readonly number[]; valueWidth: ValueWidth }> {
  const body = new WasmFunctionBodyEncoder();
  const valueWidth = emitJitValue(bodyContext(body), value);

  body.end();
  return { opcodes: wasmBodyOpcodes(body.encode()), valueWidth };
}

function bodyContext(body: WasmFunctionBodyEncoder) {
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
    emitInput: (slot: JitArchitecturalSlot) => {
      body.localGet(slot.kind === "aluFlags" ? locals.aluFlags : locals[slot.reg]);
      return cleanValueWidth(32);
    },
    emitReg: (reg: Exclude<JitArchitecturalSlot, { kind: "aluFlags" }>["reg"]) => {
      body.localGet(locals[reg]);
      return cleanValueWidth(32);
    }
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

function emitAdd(body: WasmFunctionBodyEncoder, onEmit: () => void): ValueWidth {
  onEmit();
  body.i32Const(10).i32Const(1).i32Add();
  return cleanValueWidth(32);
}

function unexpectedEmitter(): ValueWidth {
  throw new Error("unexpected value emission");
}

function useCounts(counts: readonly JitValueUseCount[]): readonly JitValueUseCount[] {
  return counts;
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
