import {
  throws
} from "node:assert";
import {
  deepStrictEqual,
  strictEqual,
  test,
  WasmFunctionBodyEncoder,
  wasmOpcode,
  IR_ALU_FLAG_MASK,
  extractOnlyWasmFunctionBody,
  wasmBodyOpcodes,
  createValueCache,
  encodeJitBlock,
  planReuseForInstruction,
  buildTimeline,
  createJitValueState,
  reg,
  const32,
  addExpr,
  addValue,
  highCostExpr,
  highCostValue,
  emitAdd,
  emitHighCostValue,
  unexpectedEmitter,
  localOpcodes,
  countOpcode,
  createOneOpValueCache,
  createOneOpSelectedValueCache,
  forcedRootCapture,
  oneOpPlacement,
  repeatedInlineExpressionBlock,
  type JitBlock,
} from "./value-local-store-test-helpers.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import { jitProducedValue } from "#backends/wasm/jit/ir/values/builders.js";
test("JIT expression emission captures repeated branch target values before the split", () => {
  const opcodes = wasmBodyOpcodes(extractOnlyWasmFunctionBody(encodeJitBlock([repeatedInlineExpressionBlock()])));

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 0);
  strictEqual(countOpcode(opcodes, wasmOpcode.localSet) > 0, true);
});

test("JIT production emission reuses repeated memory-store values", () => {
  const opcodes = productionOpcodes([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c32(1)
    },
    { op: "set", target: { kind: "mem", address: v(1) }, value: v(1), accessWidth: 32 },
    { op: "next" }
  ]);

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.localGet) >= 1, true);
});

test("JIT production emission does not reuse values across register-write epochs", () => {
  const opcodes = productionOpcodes([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c32(1)
    },
    { op: "set", target: { kind: "mem", address: v(1) }, value: v(1), accessWidth: 32 },
    { op: "set", target: { kind: "reg", reg: "eax" }, value: c32(5), accessWidth: 32 },
    { op: "get", dst: v(2), source: { kind: "reg", reg: "eax" } },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(3),
      a: v(2),
      b: c32(1)
    },
    { op: "set", target: { kind: "mem", address: v(3) }, value: v(3), accessWidth: 32 },
    { op: "next" }
  ]);

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 2);
});

test("JIT value-cache runtime follows planned timeline expression positions", () => {
  const body = new WasmFunctionBodyEncoder();
  const expressionBlock = [
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "set", target: reg("eax"), value: const32(5), accessWidth: 32 },
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) }
  ] as const;
  const timeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });
  const plan = planReuseForInstruction({
    operands: [],
    valueTimeline: timeline
  }, expressionBlock);
  const valueState = createValueCache(body, plan.cache, plan.instructions);
  const value = addValue("eax", 1);

  strictEqual(valueState.cache.canInline({ instructionIndex: 0, opIndex: 0, epoch: 0 }, value), false);
  strictEqual(valueState.cache.canInline({ instructionIndex: 0, opIndex: 4, epoch: 1 }, value), true);
  throws(
    () => valueState.cache.canInline({ instructionIndex: 0, opIndex: 5, epoch: 1 }, value),
    /JIT value cache expression op index out of range: 5/
  );
});

test("JIT value-cache runtime emits unselected values inline when unavailable", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = highCostValue();
  const valueState = createOneOpValueCache(body);
  let emitted = 0;

  valueState.cache.emitForUse(oneOpPlacement(), value, () => emitHighCostValue(body, () => { emitted += 1; }));
  valueState.cache.emitForUse(oneOpPlacement(), value, () => emitHighCostValue(body, () => { emitted += 1; }));
  body.end();

  const opcodes = wasmBodyOpcodes(body.encode());

  strictEqual(emitted, 2);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Or), 2);
  deepStrictEqual(localOpcodes(opcodes), []);
});

test("JIT value-cache runtime reuses unselected values that are already available", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = addValue("eax", 1);
  const valueState = createOneOpValueCache(body);
  let emitted = 0;

  valueState.cache.capture(forcedRootCapture(value), () => emitAdd(body, () => { emitted += 1; })).release();
  valueState.cache.emitForUse(oneOpPlacement(), value, unexpectedEmitter);
  body.end();

  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet, wasmOpcode.localGet]);
});

test("JIT value-cache runtime defines selected produced values explicitly", () => {
  const body = new WasmFunctionBodyEncoder();
  const value = jitProducedValue("load#0:0:0", "i32");
  const valueState = createOneOpSelectedValueCache(body, value);
  let emitted = 0;

  const captured = valueState.cache.define(oneOpPlacement(), value, () => emitAdd(body, () => { emitted += 1; }));
  body.end();

  captured?.release();

  strictEqual(captured !== undefined, true);
  strictEqual(emitted, 1);
  deepStrictEqual(localOpcodes(wasmBodyOpcodes(body.encode())), [wasmOpcode.localSet]);
});

test("JIT production emission prefers repeated memory-store parent expressions", () => {
  const opcodes = productionOpcodes([
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" } },
    {
      op: "value.binary",
      type: "i32",
      operator: "add",
      dst: v(1),
      a: v(0),
      b: c32(1)
    },
    {
      op: "value.binary",
      type: "i32",
      operator: "xor",
      dst: v(2),
      a: v(1),
      b: c32(0xff)
    },
    { op: "set", target: { kind: "mem", address: v(2) }, value: v(2), accessWidth: 32 },
    { op: "next" }
  ]);

  strictEqual(countOpcode(opcodes, wasmOpcode.localTee), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 1);
});

test("JIT value-cache planning does not treat flags.set as an exit-store consumer", () => {
  const expressionBlock = [
    { op: "let32", dst: { kind: "var", id: 0 }, value: highCostExpr() },
    {
      op: "flags.set",
      producer: "logic",
      writtenMask: IR_ALU_FLAG_MASK,
      undefMask: 0,
      inputs: {
        result: { kind: "var", id: 0 }
      }
    },
    { op: "next" }
  ] as const;
  const valueTimeline = buildTimeline({
    operands: [],
    expressions: expressionBlock,
    entry: createJitValueState().snapshot()
  });

  deepStrictEqual(planReuseForInstruction({
    operands: [],
    valueTimeline
  }, expressionBlock).cache.selected, []);
});

function productionOpcodes(ir: JitBlock["instructions"][number]["ir"]): readonly number[] {
  return wasmBodyOpcodes(extractOnlyWasmFunctionBody(encodeJitBlock([
    singleInstructionBlock(ir)
  ])));
}

function singleInstructionBlock(ir: JitBlock["instructions"][number]["ir"]): JitBlock {
  return {
    instructions: [{
      instructionId: "value-cache-production-test",
      eip: 0x1000,
      nextEip: 0x1001,
      nextMode: "exit",
      operands: [],
      ir
    }]
  };
}

function v(id: number): Extract<ValueRef, { kind: "var" }> {
  return { kind: "var", id };
}

function c32(value: number): Extract<ValueRef, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}
