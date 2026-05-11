import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type {
  IrExprBlock,
  IrStorageExpr,
  IrValueExpr
} from "#backends/wasm/codegen/expressions.js";
import { cleanValueWidth } from "#backends/wasm/codegen/value-width.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmOpcode, wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitJitExpressionBlock } from "#backends/wasm/jit/codegen/emit/expression-block.js";
import { createJitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import { planJitExpressionValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import type { Reg32 } from "#x86/isa/types.js";

test("JIT expression-block emitter treats let32 as an observation for supported values", () => {
  const result = emitFoundationBlock([
    { op: "let32", dst: v(0), value: addExpr("eax", 1) },
    { op: "hostTrap", vector: v(0) }
  ], { cache: false });

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 1);
  deepStrictEqual(localOpcodes(result.opcodes), [wasmOpcode.localSet]);
});

test("JIT expression-block emitter supports constant value operands", () => {
  const result = emitFoundationBlock([
    { op: "hostTrap", vector: c32(0x2e) }
  ], { cache: false });

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Const), 1);
  deepStrictEqual(localOpcodes(result.opcodes), [wasmOpcode.localSet]);
});

test("JIT expression-block emitter routes repeated expression values through value-cache", () => {
  const result = emitFoundationBlock([
    { op: "hostTrap", vector: addExpr("eax", 1) },
    { op: "hostTrap", vector: addExpr("eax", 1) }
  ]);

  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 1);
  deepStrictEqual(localOpcodes(result.opcodes), [
    wasmOpcode.localTee,
    wasmOpcode.localSet,
    wasmOpcode.localGet,
    wasmOpcode.localSet
  ]);
});

test("JIT expression-block emitter supports next as a foundation effect", () => {
  const result = emitFoundationBlock([{ op: "next" }]);

  strictEqual(result.nextCalls, 1);
});

test("JIT expression-block emitter fails loudly for unsupported let32 values", () => {
  throws(() => {
    emitFoundationBlock([
      {
        op: "let32",
        dst: v(0),
        value: {
          kind: "source",
          source: { kind: "mem", address: c32(0x1000) },
          accessWidth: 32
        }
      }
    ]);
  }, /JIT expression-block let32 has no timeline value at expression op 0/);
});

test("JIT expression-block emitter fails loudly when a value has no timeline fact", () => {
  throws(() => {
    emitFoundationBlock([
      {
        op: "hostTrap",
        vector: {
          kind: "source",
          source: { kind: "mem", address: c32(0x1000) },
          accessWidth: 32
        }
      }
    ]);
  }, /JIT expression-block value is not available at expression op 0/);
});

test("JIT expression-block emitter fails loudly for effects outside the foundation surface", () => {
  throws(() => {
    emitFoundationBlock([{ op: "jump", target: c32(0x1000) }]);
  }, /unsupported JIT expression-block op in 3H emitter: jump/);
});

type FoundationEmitResult = Readonly<{
  opcodes: readonly number[];
  nextCalls: number;
}>;

type FoundationEmitOptions = Readonly<{
  cache?: boolean;
}>;

function emitFoundationBlock(
  expressionBlock: IrExprBlock,
  options: FoundationEmitOptions = {}
): FoundationEmitResult {
  const body = new WasmFunctionBodyEncoder();
  const sinkLocal = body.addLocal(wasmValueType.i32);
  const valueTimeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });
  const cachePlan = options.cache === false
    ? undefined
    : planJitExpressionValueCache({ operands: [], valueTimeline }, expressionBlock);
  const valueCache = createJitValueCacheRuntime(body, cachePlan);
  let nextCalls = 0;

  valueCache?.beginInstruction(0);
  emitJitExpressionBlock({
    body,
    instruction: { expressionBlock, valueTimeline },
    valueCache,
    emitInput: (slot) => {
      if (slot.kind !== "reg32") {
        throw new Error(`unsupported expression-block test input: ${slot.kind}`);
      }

      body.i32Const(registerSeed(slot.reg));
      return cleanValueWidth(32);
    },
    emitNext: () => {
      nextCalls += 1;
    },
    emitHostTrap: (vector, helpers) => {
      helpers.emitValue(vector);
      body.localSet(sinkLocal);
    }
  });
  body.end();

  return {
    opcodes: wasmBodyOpcodes(body.encode()),
    nextCalls
  };
}

function v(id: number): Extract<IrValueExpr, { kind: "var" }> {
  return { kind: "var", id };
}

function c32(value: number): Extract<IrValueExpr, { kind: "const" }> {
  return { kind: "const", type: "i32", value };
}

function reg(regName: Reg32): IrStorageExpr {
  return { kind: "reg", reg: regName };
}

function sourceReg(regName: Reg32): IrValueExpr {
  return { kind: "source", source: reg(regName), accessWidth: 32 };
}

function addExpr(regName: Reg32, value: number): IrValueExpr {
  return {
    kind: "value.binary",
    type: "i32",
    operator: "add",
    a: sourceReg(regName),
    b: c32(value)
  };
}

function registerSeed(regName: Reg32): number {
  switch (regName) {
    case "eax":
      return 1;
    case "ebx":
      return 2;
    case "ecx":
      return 3;
    case "edx":
      return 4;
    case "esi":
      return 5;
    case "edi":
      return 6;
    case "esp":
      return 7;
    case "ebp":
      return 8;
  }
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
