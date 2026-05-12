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
import { jitProducedValue, type JitProducedValue } from "#backends/wasm/jit/ir/values.js";
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

test("JIT expression-block emitter emits uncached produced let32 definitions at their source point", () => {
  const produced = jitProducedValue("load#uncached-produced:0:0:0", "i32");
  const result = emitFoundationBlock([
    {
      op: "let32",
      dst: v(0),
      value: {
        kind: "source",
        source: { kind: "mem", address: c32(0x1000) },
        accessWidth: 32
      }
    }
  ], {
    producedValuesByVarId: new Map([[0, produced]])
  });

  strictEqual(countOpcode(result.opcodes, wasmOpcode.drop), 1);
  deepStrictEqual(localOpcodes(result.opcodes), []);
});

test("JIT expression-block emitter fails when a produced consumer has no captured definition", () => {
  const produced = jitProducedValue("load#uncaptured-produced:0:0:0", "i32");

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
      },
      { op: "hostTrap", vector: v(0) }
    ], {
      cache: false,
      producedValuesByVarId: new Map([[0, produced]])
    });
  }, /produced JIT value is not available for lowering/);
});

test("JIT expression-block emitter routes normal planned effects", () => {
  const result = emitFoundationBlock([
    { op: "set", target: reg("ebx"), value: addExpr("eax", 1), accessWidth: 32 },
    { op: "jump", target: c32(0x1000) }
  ]);

  strictEqual(result.setCalls, 1);
  strictEqual(result.jumpCalls, 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 1);
});

type FoundationEmitResult = Readonly<{
  opcodes: readonly number[];
  nextCalls: number;
  setCalls: number;
  jumpCalls: number;
  conditionalJumpCalls: number;
}>;

type FoundationEmitOptions = Readonly<{
  cache?: boolean;
  producedValuesByVarId?: ReadonlyMap<number, JitProducedValue>;
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
    entryValueState: createJitValueState().snapshot(),
    ...(options.producedValuesByVarId === undefined
      ? {}
      : { producedValuesByVarId: options.producedValuesByVarId })
  });
  const cachePlan = options.cache === false
    ? undefined
    : planJitExpressionValueCache({ operands: [], valueTimeline }, expressionBlock);
  const valueCache = createJitValueCacheRuntime(body, cachePlan);
  let nextCalls = 0;
  let setCalls = 0;
  let jumpCalls = 0;
  let conditionalJumpCalls = 0;

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
    emitGet: (source) => {
      if (source.kind === "mem") {
        body.i32Const(0x77);
        return cleanValueWidth(32);
      }

      if (source.kind !== "reg") {
        throw new Error(`unsupported expression-block test get: ${source.kind}`);
      }

      body.i32Const(registerSeed(source.reg));
      return cleanValueWidth(32);
    },
    emitSet: (op, helpers) => {
      setCalls += 1;
      helpers.emitValue(op.value);
      body.localSet(sinkLocal);
    },
    emitAddress: () => {
      throw new Error("expression-block test address emission is not implemented");
    },
    emitSetFlags: (descriptor, helpers) => {
      for (const value of Object.values(descriptor.inputs)) {
        helpers.emitValue(value);
        body.localSet(sinkLocal);
      }
    },
    emitNextEip: () => {
      body.i32Const(0);
      return cleanValueWidth(32);
    },
    emitNext: () => {
      nextCalls += 1;
    },
    emitJump: (target, helpers) => {
      jumpCalls += 1;
      helpers.emitValue(target);
      body.localSet(sinkLocal);
    },
    emitConditionalJump: (condition, taken, notTaken, helpers) => {
      conditionalJumpCalls += 1;
      helpers.emitValue(condition);
      body.localSet(sinkLocal);
      helpers.emitValue(taken);
      body.localSet(sinkLocal);
      helpers.emitValue(notTaken);
      body.localSet(sinkLocal);
    },
    emitHostTrap: (vector, helpers) => {
      helpers.emitValue(vector);
      body.localSet(sinkLocal);
    }
  });
  body.end();

  return {
    opcodes: wasmBodyOpcodes(body.encode()),
    nextCalls,
    setCalls,
    jumpCalls,
    conditionalJumpCalls
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
