import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import type { ConditionCode, FlagProducerName, ValueRef } from "#x86/ir/model/types.js";
import { x86ArithmeticFlagMask } from "#x86/isa/flags.js";
import { i32 } from "#x86/state/cpu-state.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { emitFlagsCondition, emitFlagProducerCondition } from "#backends/wasm/codegen/conditions.js";
import { wasmIrLocalAluFlagsStorage } from "#backends/wasm/codegen/alu-flags.js";
import { emitSetFlags } from "#backends/wasm/codegen/flags.js";
import {
  constValueWidth,
  emitMaskValueToWidth,
  untrackedValueWidth,
  type ValueWidth
} from "#backends/wasm/codegen/value-width.js";

const unmodeledStorageBit = 1 << 9;

test("emitSetFlags writes generated flags and normalizes arithmetic flag storage", async () => {
  const add = await instantiateSetFlags("add");
  const logic = await instantiateSetFlags("logic");

  strictEqual(
    add(0xffff_ffff, 1, 0, unmodeledStorageBit | x86ArithmeticFlagMask.SF | x86ArithmeticFlagMask.OF),
    x86ArithmeticFlagMask.CF |
      x86ArithmeticFlagMask.PF |
      x86ArithmeticFlagMask.AF |
      x86ArithmeticFlagMask.ZF
  );
  strictEqual(
    logic(0, 0, 0, unmodeledStorageBit | x86ArithmeticFlagMask.CF | x86ArithmeticFlagMask.AF | x86ArithmeticFlagMask.OF),
    x86ArithmeticFlagMask.PF | x86ArithmeticFlagMask.ZF
  );
});

test("emitSetFlags supports partial producers that preserve CF", async () => {
  const inc = await instantiateSetFlags("inc");

  strictEqual(
    inc(0xffff_ffff, 0, 0, x86ArithmeticFlagMask.CF | x86ArithmeticFlagMask.SF),
    x86ArithmeticFlagMask.CF |
      x86ArithmeticFlagMask.PF |
      x86ArithmeticFlagMask.AF |
      x86ArithmeticFlagMask.ZF
  );
});

test("emitSetFlags computes and writes only requested materialization bits", async () => {
  const add = await instantiateSetFlags("add", x86ArithmeticFlagMask.ZF);
  const opcodes = wasmBodyOpcodes(encodeSetFlagsFunctionBody("add", x86ArithmeticFlagMask.ZF).encode());

  strictEqual(
    add(0xffff_ffff, 1, 0, x86ArithmeticFlagMask.SF),
    x86ArithmeticFlagMask.SF | x86ArithmeticFlagMask.ZF
  );
  strictEqual(opcodes.includes(wasmOpcode.i32LtU), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Popcnt), false);
  strictEqual(opcodes.includes(wasmOpcode.i32ShrU), false);
});

test("emitSetFlags does not allocate an accumulator local", () => {
  const body = new WasmFunctionBodyEncoder(4);
  const aluFlags = wasmIrLocalAluFlagsStorage(body, 3);

  emitSetFlags(body, aluFlags, createIrFlagSetOp("logic", { result: v(2) }), {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  body.localGet(3).end();

  strictEqual(body.encode()[0], 0);
});

test("emitFlagsCondition evaluates compound condition formulas from arithmetic flags", async () => {
  const le = await instantiateCondition("LE");
  const g = await instantiateCondition("G");

  strictEqual(le(x86ArithmeticFlagMask.ZF), 1);
  strictEqual(le(x86ArithmeticFlagMask.SF), 1);
  strictEqual(le(x86ArithmeticFlagMask.SF | x86ArithmeticFlagMask.OF), 0);

  strictEqual(g(0), 1);
  strictEqual(g(x86ArithmeticFlagMask.ZF), 0);
  strictEqual(g(x86ArithmeticFlagMask.SF), 0);
  strictEqual(g(x86ArithmeticFlagMask.SF | x86ArithmeticFlagMask.OF), 1);
});

test("emitFlagProducerCondition evaluates producer-backed sub comparisons directly", async () => {
  const eq = await instantiateFlagProducerCondition("E");
  const below = await instantiateFlagProducerCondition("B");
  const signedLess = await instantiateFlagProducerCondition("L");
  const signedGreater = await instantiateFlagProducerCondition("G");

  strictEqual(eq(5, 5), 1);
  strictEqual(eq(5, 6), 0);
  strictEqual(below(0, 1), 1);
  strictEqual(below(0xffff_ffff, 1), 0);
  strictEqual(signedLess(0xffff_ffff, 1), 1);
  strictEqual(signedGreater(0x7fff_ffff, 0xffff_ffff), 1);
});

test("emitFlagProducerCondition evaluates producer-backed result conditions directly", async () => {
  const incZero = await instantiateResultFlagProducerCondition("inc", "E");
  const logicNonZero = await instantiateResultFlagProducerCondition("logic", "NE");
  const decSign = await instantiateResultFlagProducerCondition("dec", "S");
  const addNotSign = await instantiateResultFlagProducerCondition("add", "NS");
  const subZero = await instantiateResultFlagProducerCondition("sub", "E");
  const addParity = await instantiateResultFlagProducerCondition("add", "P");
  const logicNotParity = await instantiateResultFlagProducerCondition("logic", "NP");
  const logicBelow = await instantiateResultFlagProducerCondition("logic", "B");
  const logicAboveEqual = await instantiateResultFlagProducerCondition("logic", "AE");
  const logicLessEqual = await instantiateResultFlagProducerCondition("logic", "LE");
  const logicGreater = await instantiateResultFlagProducerCondition("logic", "G");

  strictEqual(incZero(0), 1);
  strictEqual(incZero(1), 0);
  strictEqual(logicNonZero(0), 0);
  strictEqual(logicNonZero(1), 1);
  strictEqual(decSign(0x8000_0000), 1);
  strictEqual(addNotSign(0x7fff_ffff), 1);
  strictEqual(subZero(0), 1);
  strictEqual(subZero(1), 0);
  strictEqual(addParity(3), 1);
  strictEqual(logicNotParity(1), 1);
  strictEqual(logicBelow(0), 0);
  strictEqual(logicAboveEqual(0), 1);
  strictEqual(logicLessEqual(0), 1);
  strictEqual(logicLessEqual(0x8000_0000), 1);
  strictEqual(logicLessEqual(1), 0);
  strictEqual(logicGreater(1), 1);
  strictEqual(logicGreater(0), 0);
  strictEqual(logicGreater(0x8000_0000), 0);
});

async function instantiateSetFlags(
  producer: FlagProducerName,
  mask?: number
): Promise<(left: number, right: number, result: number, aluFlags: number) => number> {
  const module = await WebAssembly.compile(encodeSetFlagsModule(producer, mask));
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (left: number, right: number, result: number, aluFlags: number) => number;
}

function encodeSetFlagsModule(producer: FlagProducerName, mask?: number): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32, wasmValueType.i32, wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = encodeSetFlagsFunctionBody(producer, mask);

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function encodeSetFlagsFunctionBody(producer: FlagProducerName, mask?: number): WasmFunctionBodyEncoder {
  const body = new WasmFunctionBodyEncoder(4);
  const aluFlags = wasmIrLocalAluFlagsStorage(body, 3);
  const inputs: Readonly<Record<string, ValueRef>> = producer === "logic"
    ? { result: v(2) }
    : { left: v(0), right: v(1), result: v(2) };

  emitSetFlags(
    body,
    aluFlags,
    createIrFlagSetOp(producer, inputs),
    {
      emitValue: (value) => emitValueExpr(body, value),
      emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
    },
    mask === undefined ? undefined : { mask }
  );
  body.localGet(3).end();

  return body;
}

async function instantiateCondition(cc: ConditionCode): Promise<(aluFlags: number) => number> {
  const module = await WebAssembly.compile(encodeConditionModule(cc));
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (aluFlags: number) => number;
}

async function instantiateFlagProducerCondition(
  cc: ConditionCode
): Promise<(left: number, right: number) => number> {
  const module = await WebAssembly.compile(encodeFlagProducerConditionModule(cc));
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (left: number, right: number) => number;
}

function encodeConditionModule(cc: ConditionCode): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(1);

  emitFlagsCondition(body, wasmIrLocalAluFlagsStorage(body, 0), cc);
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function encodeFlagProducerConditionModule(cc: ConditionCode): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(2);

  emitFlagProducerCondition(body, {
    kind: "flagProducer.condition",
    cc,
    producer: "sub",
    writtenMask: createIrFlagSetOp("sub", { left: v(0), right: v(1), result: v(2) }).writtenMask,
    undefMask: 0,
    inputs: { left: v(0), right: v(1) }
  }, {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

async function instantiateResultFlagProducerCondition(
  producer: FlagProducerName,
  cc: ConditionCode
): Promise<(result: number) => number> {
  const module = await WebAssembly.compile(encodeResultFlagProducerConditionModule(producer, cc));
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (result: number) => number;
}

function encodeResultFlagProducerConditionModule(
  producer: FlagProducerName,
  cc: ConditionCode
): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(1);
  const descriptor = createIrFlagSetOp(producer, flagSetInputs(producer));

  emitFlagProducerCondition(body, {
    kind: "flagProducer.condition",
    cc,
    producer,
    writtenMask: descriptor.writtenMask,
    undefMask: descriptor.undefMask,
    inputs: { result: v(0) }
  }, {
    emitValue: (value) => emitValueExpr(body, value),
    emitMaskedValue: (value, width) => emitMaskValueToWidth(body, width, emitValueExpr(body, value))
  });
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function emitValueExpr(body: WasmFunctionBodyEncoder, value: IrValueExpr): ValueWidth {
  switch (value.kind) {
    case "var":
      body.localGet(value.id);
      return untrackedValueWidth();
    case "const":
      body.i32Const(i32(value.value));
      return constValueWidth(value.value);
    case "nextEip":
      body.i32Const(0);
      return constValueWidth(0);
    default:
      throw new Error(`unsupported flag test value expression: ${value.kind}`);
  }
}

function v(id: number): ValueRef {
  return { kind: "var", id };
}

function flagSetInputs(producer: FlagProducerName): Readonly<Record<string, ValueRef>> {
  switch (producer) {
    case "logic":
      return { result: v(0) };
    case "inc":
    case "dec":
      return { left: v(0), result: v(0) };
    case "add":
    case "sub":
      return { left: v(0), right: v(0), result: v(0) };
  }
}
