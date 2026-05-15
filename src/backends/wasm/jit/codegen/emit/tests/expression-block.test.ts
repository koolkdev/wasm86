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
import { emitJitGet } from "#backends/wasm/jit/codegen/emit/operands.js";
import type { JitInstructionEmitContext } from "#backends/wasm/jit/codegen/emit/block-emitter.js";
import { createJitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import type { JitPlannedEffect } from "#backends/wasm/jit/codegen/plan/effect-plan.js";
import { planJitValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import {
  buildJitInstructionValueTimeline,
  JitTimelineOpContext
} from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import { planJitValueUses } from "#backends/wasm/jit/codegen/plan/value-uses.js";
import { rootExpressionPathScopes } from "#backends/wasm/jit/codegen/tests/path-scope-test-helpers.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import { jitProducedValue } from "#backends/wasm/jit/ir/value-builders.js";
import type { JitProducedValue } from "#backends/wasm/jit/ir/value-types.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { IR_ALU_FLAG_MASK } from "#x86/ir/model/flag-effects.js";
import type { Reg32 } from "#x86/isa/types.js";

test("JIT expression-block emitter resolves timeline values for planned effects", () => {
  const result = emitFoundationBlock([
    { op: "let32", dst: v(0), value: addExpr("eax", 1) },
    { op: "hostTrap", vector: v(0) }
  ], { cache: false });

  strictEqual(result.localCount, 1);
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

test("JIT expression-block emitter supports planned exit edges", () => {
  const result = emitFoundationBlock([{ op: "next" }]);

  strictEqual(result.nextCalls, 1);
});

test("JIT expression-block emitter treats flags.set as value-state only", () => {
  const result = emitFoundationBlock([
    {
      op: "flags.set",
      producer: "logic",
      writtenMask: IR_ALU_FLAG_MASK,
      undefMask: 0,
      inputs: {
        result: c32(0)
      }
    }
  ]);

  deepStrictEqual(result.opcodes, [wasmOpcode.end]);
});

test("JIT expression-block emitter fails when a planned produced value has no definition", () => {
  throws(() => {
    emitFoundationBlock([
      { op: "let32", dst: v(0), value: c32(1) }
    ], {
      plannedEffects: [{ opIndex: 0, kind: "producedValueDefinition" }]
    });
  }, /JIT planned produced value has no timeline definition at expression op 0/);
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

test("JIT operand emission fails when a register read has no planned timeline fact", () => {
  const expressionBlock = [
    { op: "let32", dst: v(0), value: c32(1) }
  ] as const satisfies IrExprBlock;
  const valueTimeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock,
    entryValueState: createJitValueState().snapshot()
  });

  throws(() => {
    emitJitGet(
      { body: new WasmFunctionBodyEncoder() } as unknown as JitInstructionEmitContext,
      new JitTimelineOpContext(valueTimeline, 0),
      reg("eax"),
      32,
      {
        emitValue: () => cleanValueWidth(32),
        emitMaskedValue: () => cleanValueWidth(32)
      }
    );
  }, /JIT register read eax is not available in the JIT value timeline/);
});

test("JIT expression-block emitter skips uncached produced definitions with no consumer", () => {
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
    producedValuesByVarId: new Map([[0, produced]]),
    plannedEffects: [{ opIndex: 0, kind: "producedValueDefinition" }]
  });

  strictEqual(countOpcode(result.opcodes, wasmOpcode.drop), 0);
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
      producedValuesByVarId: new Map([[0, produced]]),
      plannedEffects: [
        { opIndex: 0, kind: "producedValueDefinition" },
        { opIndex: 1, kind: "hostTrap" }
      ]
    });
  }, /produced JIT value is not available for lowering/);
});

test("JIT expression-block emitter routes normal planned effects", () => {
  const result = emitFoundationBlock([
    { op: "set", target: { kind: "mem", address: c32(0x1000) }, value: addExpr("eax", 1), accessWidth: 32 },
    { op: "jump", target: c32(0x1000) }
  ]);

  strictEqual(result.setCalls, 1);
  strictEqual(result.jumpCalls, 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 1);
});

test("JIT expression-block emitter routes memory guards as planned effects", () => {
  const result = emitFoundationBlock([
    { op: "memory.guard", address: addExpr("eax", 1), byteLength: 4, access: "read" }
  ]);

  strictEqual(result.guardCalls, 1);
  strictEqual(countOpcode(result.opcodes, wasmOpcode.i32Add), 1);
  deepStrictEqual(localOpcodes(result.opcodes), [wasmOpcode.localSet]);
});

type FoundationEmitResult = Readonly<{
  opcodes: readonly number[];
  localCount: number;
  nextCalls: number;
  setCalls: number;
  guardCalls: number;
  jumpCalls: number;
  conditionalJumpCalls: number;
}>;

type FoundationEmitOptions = Readonly<{
  cache?: boolean;
  producedValuesByVarId?: ReadonlyMap<number, JitProducedValue>;
  plannedEffects?: readonly PlannedEffectInput[];
}>;

type PlannedEffectInput = Readonly<{
  opIndex: number;
  kind: JitPlannedEffect["kind"];
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
    : planJitValueCache(
        { operands: [], valueTimeline },
        expressionBlock,
        planJitValueUses([{
          expressionBlock,
          valueTimeline,
          expressionPathScopes: rootExpressionPathScopes(expressionBlock),
          materializationUses: new Map()
        }])
      );
  const valueCache = createJitValueCacheRuntime(body, cachePlan);
  let nextCalls = 0;
  let setCalls = 0;
  let guardCalls = 0;
  let jumpCalls = 0;
  let conditionalJumpCalls = 0;

  valueCache?.beginInstruction(0);
  emitJitExpressionBlock({
    body,
    instruction: {
      expressionBlock,
      valueTimeline,
      plannedValueCaptures: new Map(),
      plannedEffects: buildPlannedEffects(
        expressionBlock,
        options.plannedEffects
      )
    },
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
    emitMemoryGuard: (op, helpers) => {
      guardCalls += 1;
      helpers.emitValue(op.address);
      body.localSet(sinkLocal);
    },
    emitAddress: () => {
      throw new Error("expression-block test address emission is not implemented");
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

  const encoded = body.encode();

  return {
    opcodes: wasmBodyOpcodes(encoded),
    localCount: wasmBodyLocalCount(encoded),
    nextCalls,
    setCalls,
    guardCalls,
    jumpCalls,
    conditionalJumpCalls
  };
}

function buildPlannedEffects(
  expressionBlock: IrExprBlock,
  effects: readonly PlannedEffectInput[] | undefined
): readonly JitPlannedEffect[] {
  return (effects ?? defaultPlannedEffects(expressionBlock)).map((effect) => ({
    placement: {
      instructionIndex: 0,
      opIndex: effect.opIndex,
      epoch: 0
    },
    sourceOpIndex: effect.opIndex,
    kind: effect.kind,
    exits: [],
    valueRoots: []
  }));
}

function defaultPlannedEffects(expressionBlock: IrExprBlock): readonly PlannedEffectInput[] {
  const plannedEffects: PlannedEffectInput[] = [];

  for (let opIndex = 0; opIndex < expressionBlock.length; opIndex += 1) {
    const op = expressionBlock[opIndex]!;

    switch (op.op) {
      case "memory.guard":
        plannedEffects.push({ opIndex, kind: "memoryGuard" });
        break;
      case "set":
        plannedEffects.push({ opIndex, kind: "memoryStore" });
        break;
      case "jump":
      case "conditionalJump":
        plannedEffects.push({ opIndex, kind: "controlTransfer" });
        break;
      case "hostTrap":
        plannedEffects.push({ opIndex, kind: "hostTrap" });
        break;
      case "next":
        plannedEffects.push({ opIndex, kind: "exitEdge" });
        break;
      case "let32":
      case "flags.set":
        break;
    }
  }

  return plannedEffects;
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
