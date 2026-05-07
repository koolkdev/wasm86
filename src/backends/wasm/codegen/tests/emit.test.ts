import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { Reg32 } from "#x86/isa/types.js";
import { buildIr } from "#x86/ir/build/builder.js";
import type { IrExpressionOptions, IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { IrBlock } from "#x86/ir/model/types.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmOpcode, wasmValueType, type WasmValueType } from "#backends/wasm/encoder/types.js";
import { emitIrToWasm, type WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { untrackedValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";

const nextEipValue = 0x1234_5678;

test("emitIrToWasm emits arithmetic through storage callbacks", async () => {
  const run = await instantiateEmittedBinary(
    buildIr((s) => {
      const left = s.get(s.operand(0));
      const right = s.get(s.operand(1));
      const adjusted = s.i32Add(left, 9);

      s.set(s.reg("eax"), s.i32Or(s.i32Xor(adjusted, right), 0x80));
    })
  );

  strictEqual(run(0x10, 0x20), 0xb9);
  strictEqual(run(0, 0), 0x89);
});

test("emitIrToWasm emits conditional control values with nested emitValue", async () => {
  const run = await instantiateEmittedBinary(
    buildIr((s) => {
      const left = s.get(s.operand(0));
      const right = s.get(s.operand(1));
      const sum = s.i32Add(left, right);

      s.conditionalJump(s.i32And(sum, 1), sum, s.nextEip());
    })
  );

  strictEqual(run(1, 2), 3);
  strictEqual(run(2, 2), nextEipValue);
});

test("emitIrToWasm emits value.select as Wasm select", async () => {
  const program = buildIr((s) => {
    const value = s.i32Select(s.get(s.operand(1)), s.get(s.operand(0)), 0x55);

    s.set(s.reg("eax"), value);
  });
  const run = await instantiateEmittedBinary(program);
  const opcodes = emittedBodyOpcodes(program);

  strictEqual(run(0x33, 1), 0x33);
  strictEqual(run(0x33, 0), 0x55);
  strictEqual(opcodes.includes(wasmOpcode.select), true);
  strictEqual(opcodes.includes(wasmOpcode.if), false);
});

test("emitIrToWasm uses planned slots for non-overlapping IR locals", () => {
  const scratch = emitWithTrackingScratch(
    buildIr((s) => {
      const first = s.get(s.operand(0));

      s.set(s.reg("eax"), first);

      const second = s.get(s.operand(1));

      s.set(s.reg("ebx"), second);
      s.next();
    }),
    { canInlineGet: () => false }
  );

  strictEqual(scratch.maxLive, 1);
});

test("emitIrToWasm uses a reused input slot for a materialized let destination", () => {
  const scratch = emitWithTrackingScratch(
    buildIr((s) => {
      const input = s.get(s.operand(0));
      const sum = s.i32Add(input, 1);

      s.set(s.reg("eax"), sum);
      s.set(s.reg("ebx"), sum);
      s.next();
    }),
    { canInlineGet: () => false }
  );

  strictEqual(scratch.maxLive, 1);
});

async function instantiateEmittedBinary(program: IrBlock): Promise<(left: number, right: number) => number> {
  const module = await WebAssembly.compile(encodeEmittedBinaryModule(program));
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (left: number, right: number) => number;
}

function encodeEmittedBinaryModule(program: IrBlock): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = emitTestProgram(program);

  body.end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function emittedBodyOpcodes(program: IrBlock): readonly number[] {
  const body = emitTestProgram(program);

  body.end();
  return wasmBodyOpcodes(body.encode());
}

function emitTestProgram(program: IrBlock): WasmFunctionBodyEncoder {
  const body = new WasmFunctionBodyEncoder(2);
  const scratch = new WasmLocalScratchAllocator(body);
  const regLocals: Partial<Record<Reg32, number>> = {
    eax: body.addLocal(wasmValueType.i32)
  };

  emitIrToWasm(program, {
    body,
    scratch,
    expression: { canInlineGet: () => true },
    emitGet: (source) => emitGet(body, regLocals, source),
    emitSet: (target, value, _accessWidth, helpers) => emitSet(body, regLocals, target, value, helpers),
    emitAddress: (source) => {
      if (source.kind !== "operand") {
        unsupported(`${source.kind} address`);
      }
      body.i32Const(0x1000 + source.index);
    },
    emitSetFlags: () => unsupported("flags.set"),
    emitMaterializeFlags: () => unsupported("flags.materialize"),
    emitBoundaryFlags: () => unsupported("flags.boundary"),
    emitAluFlagsCondition: () => unsupported("aluFlags.condition"),
    emitFlagProducerCondition: () => unsupported("flagProducer.condition"),
    emitNext: () => {
      body.localGet(requireRegLocal(regLocals, "eax"));
    },
    emitNextEip: () => {
      body.i32Const(nextEipValue);
    },
    emitJump: (target, helpers) => {
      helpers.emitValue(target);
    },
    emitConditionalJump: (condition, taken, notTaken, helpers) => {
      helpers.emitValue(condition);
      body.ifBlock(undefined, wasmValueType.i32);
      helpers.emitValue(taken);
      body.elseBlock();
      helpers.emitValue(notTaken);
      body.endBlock();
    },
    emitHostTrap: (vector, helpers) => {
      helpers.emitValue(vector);
    }
  });

  scratch.assertClear();
  return body;
}

function emitWithTrackingScratch(
  program: IrBlock,
  expression: IrExpressionOptions
): TrackingScratchAllocator {
  const body = new WasmFunctionBodyEncoder(2);
  const scratch = new TrackingScratchAllocator(body);
  const regLocals: Partial<Record<Reg32, number>> = {
    eax: body.addLocal(wasmValueType.i32),
    ebx: body.addLocal(wasmValueType.i32)
  };

  emitIrToWasm(program, {
    body,
    scratch,
    expression,
    emitGet: (source) => emitGet(body, regLocals, source),
    emitSet: (target, value, _accessWidth, helpers) => emitSet(body, regLocals, target, value, helpers),
    emitAddress: () => unsupported("address"),
    emitSetFlags: () => unsupported("flags.set"),
    emitMaterializeFlags: () => unsupported("flags.materialize"),
    emitBoundaryFlags: () => unsupported("flags.boundary"),
    emitAluFlagsCondition: () => unsupported("aluFlags.condition"),
    emitFlagProducerCondition: () => unsupported("flagProducer.condition"),
    emitNext: () => {},
    emitNextEip: () => {
      body.i32Const(nextEipValue);
    },
    emitJump: (target, helpers) => {
      helpers.emitValue(target);
    },
    emitConditionalJump: (condition, taken, notTaken, helpers) => {
      helpers.emitValue(condition);
      helpers.emitValue(taken);
      helpers.emitValue(notTaken);
    },
    emitHostTrap: (vector, helpers) => {
      helpers.emitValue(vector);
    }
  });

  scratch.assertClear();
  return scratch;
}

function emitGet(
  body: WasmFunctionBodyEncoder,
  regLocals: Partial<Record<Reg32, number>>,
  source: IrStorageExpr
): ValueWidth {
  switch (source.kind) {
    case "operand":
      if (source.index > 1) {
        throw new Error(`missing test operand: ${source.index}`);
      }
      body.localGet(source.index);
      return untrackedValueWidth();
    case "reg":
      body.localGet(requireRegLocal(regLocals, source.reg));
      return untrackedValueWidth();
    case "mem":
      unsupported("mem get");
  }
}

function emitSet(
  body: WasmFunctionBodyEncoder,
  regLocals: Partial<Record<Reg32, number>>,
  target: IrStorageExpr,
  value: IrValueExpr,
  helpers: WasmIrEmitHelpers
): void {
  if (target.kind !== "reg") {
    unsupported(`${target.kind} set`);
  }

  helpers.emitValue(value);
  body.localSet(requireRegLocal(regLocals, target.reg));
}

function requireRegLocal(regLocals: Partial<Record<Reg32, number>>, reg: Reg32): number {
  const local = regLocals[reg];

  if (local === undefined) {
    throw new Error(`missing test register local: ${reg}`);
  }

  return local;
}

function unsupported(message: string): never {
  throw new Error(`unsupported emit test hook: ${message}`);
}

class TrackingScratchAllocator extends WasmLocalScratchAllocator {
  readonly #liveLocals = new Set<number>();
  maxLive = 0;

  override allocLocal(type: WasmValueType): number {
    const local = super.allocLocal(type);

    this.#liveLocals.add(local);
    this.maxLive = Math.max(this.maxLive, this.#liveLocals.size);
    return local;
  }

  override freeLocal(index: number): void {
    super.freeLocal(index);
    this.#liveLocals.delete(index);
  }
}
