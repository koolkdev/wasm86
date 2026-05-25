import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { Reg32, RegName } from "#x86/isa/types.js";
import { registerAlias } from "#x86/isa/registers.js";
import { buildIr } from "#x86/ir/build/builder.js";
import type { IrExprBlock, IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { IrBlock } from "#x86/ir/model/types.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmOpcode, wasmValueType, type WasmValueType } from "#backends/wasm/encoder/types.js";
import { emitIrExpressionBlockToWasm, emitIrToWasm, type WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import { emitWriteFlags } from "#backends/wasm/codegen/flags.js";
import { wasmIrLocalAluFlagsStorage } from "#backends/wasm/codegen/alu-flags.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { untrackedValueWidth, type ValueWidth } from "#backends/wasm/codegen/value-width.js";
import { x86ArithmeticFlagMask } from "#x86/isa/flags.js";

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

test("emitIrToWasm lowers i32Shl to Wasm shift-left", async () => {
  const program = buildIr((s) => {
    const left = s.get(s.operand(0));

    s.set(s.reg("eax"), s.i32Shl(left, 2));
  });
  const run = await instantiateEmittedBinary(program);
  const opcodes = emittedBodyOpcodes(program);

  strictEqual(run(0x11, 0), 0x44);
  strictEqual(opcodes.includes(wasmOpcode.i32Shl), true);
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

test("emitIrToWasm lowers projected signed compares", async () => {
  const program = buildIr((s) => {
    const low = s.project(8, s.get(s.operand(0)));

    s.set(s.reg("eax"), s.compare(8, "lt_s", low, 0));
  });
  const run = await instantiateEmittedBinary(program);
  const opcodes = emittedBodyOpcodes(program);

  strictEqual(run(0x7f, 0), 0);
  strictEqual(run(0xff, 0), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Extend8S), 2);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32LtS), 1);
  strictEqual(countOpcode(opcodes, wasmOpcode.i32Xor), 0);
});

test("emitIrToWasm lowers semantic flag writes through concrete flag storage", async () => {
  const run = await instantiateFlagWrite(
    buildIr((s) => {
      const value = s.get(s.operand(0));
      const low = s.project(8, value);

      s.writeFlags({
        cells: {
          ZF: s.flagExpr(s.compare(8, "eq", low, 0)),
          AF: s.flagUndef()
        },
        conditions: {
          E: s.compare(8, "eq", low, 0xff)
        }
      });
    })
  );
  const preserved = x86ArithmeticFlagMask.CF | x86ArithmeticFlagMask.SF;

  strictEqual(
    run(0x100, preserved | x86ArithmeticFlagMask.AF),
    preserved | x86ArithmeticFlagMask.ZF
  );
});

test("emitIrToWasm uses planned slots for non-overlapping IR locals", () => {
  const scratch = emitWithTrackingScratch(
    buildIr((s) => {
      const first = s.get(s.operand(0));

      s.set(s.reg("eax"), first);

      const second = s.get(s.operand(1));

      s.set(s.reg("ebx"), second);
      s.next();
    })
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
    })
  );

  strictEqual(scratch.maxLive, 1);
});

test("emitIrExpressionBlockToWasm keeps let32 local-first in the shared emitter", () => {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const sinkLocal = body.addLocal(wasmValueType.i32);
  const block: IrExprBlock = [
    { op: "let32", dst: { kind: "var", id: 0 }, value: { kind: "const", type: "i32", value: 0x2a } },
    { op: "hostTrap", vector: { kind: "var", id: 0 } }
  ];

  emitIrExpressionBlockToWasm(block, {
    body,
    scratch,
    emitGet: () => unsupported("get"),
    emitSet: () => unsupported("set"),
    emitMemoryGuard: () => unsupported("memory.guard"),
    emitAddress: () => unsupported("address"),
    emitSetFlags: () => unsupported("flags.set"),
    emitWriteFlags: () => unsupported("flags.write"),
    emitFlagsCondition: () => unsupported("flags.condition"),
    emitNext: () => unsupported("next"),
    emitNextEip: () => unsupported("nextEip"),
    emitJump: () => unsupported("jump"),
    emitConditionalJump: () => unsupported("conditionalJump"),
    emitHostTrap: (vector, helpers) => {
      helpers.emitValue(vector);
      body.localSet(sinkLocal);
    }
  });
  scratch.assertClear();
  body.end();

  const encoded = body.encode();
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(wasmBodyLocalCount(encoded), 2);
  strictEqual(countOpcode(opcodes, wasmOpcode.localSet), 2);
  strictEqual(countOpcode(opcodes, wasmOpcode.localGet), 1);
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

async function instantiateFlagWrite(program: IrBlock): Promise<(value: number, aluFlags: number) => number> {
  const module = await WebAssembly.compile(encodeFlagWriteModule(program));
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (value: number, aluFlags: number) => number;
}

function encodeFlagWriteModule(program: IrBlock): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(2);
  const scratch = new WasmLocalScratchAllocator(body);

  emitIrToWasm(program, {
    body,
    scratch,
    emitGet: (source) => {
      if (source.kind !== "operand" || source.index !== 0) {
        unsupported("flag write get");
      }

      body.localGet(0);
      return untrackedValueWidth();
    },
    emitSet: () => unsupported("set"),
    emitMemoryGuard: () => unsupported("memory.guard"),
    emitAddress: () => unsupported("address"),
    emitSetFlags: () => unsupported("flags.set"),
    emitWriteFlags: (descriptor, helpers) =>
      emitWriteFlags(body, wasmIrLocalAluFlagsStorage(body, 1), descriptor, helpers),
    emitFlagsCondition: () => unsupported("flags.condition"),
    emitNext: () => {
      body.localGet(1);
    },
    emitNextEip: () => unsupported("nextEip"),
    emitJump: () => unsupported("jump"),
    emitConditionalJump: () => unsupported("conditionalJump"),
    emitHostTrap: () => unsupported("hostTrap")
  });
  scratch.assertClear();
  body.end();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
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
    emitGet: (source) => emitGet(body, regLocals, source),
    emitSet: (target, value, _accessWidth, helpers) => emitSet(body, regLocals, target, value, helpers),
    emitMemoryGuard: () => unsupported("memory.guard"),
    emitAddress: (source) => {
      if (source.kind !== "operand") {
        unsupported(`${source.kind} address`);
      }
      body.i32Const(0x1000 + source.index);
    },
    emitSetFlags: () => unsupported("flags.set"),
    emitWriteFlags: () => unsupported("flags.write"),
    emitFlagsCondition: () => unsupported("flags.condition"),
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
  program: IrBlock
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
    emitGet: (source) => emitGet(body, regLocals, source),
    emitSet: (target, value, _accessWidth, helpers) => emitSet(body, regLocals, target, value, helpers),
    emitMemoryGuard: () => unsupported("memory.guard"),
    emitAddress: () => unsupported("address"),
    emitSetFlags: () => unsupported("flags.set"),
    emitWriteFlags: () => unsupported("flags.write"),
    emitFlagsCondition: () => unsupported("flags.condition"),
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

function requireRegLocal(regLocals: Partial<Record<Reg32, number>>, reg: RegName): number {
  const base = registerAlias(reg).base;
  const local = regLocals[base];

  if (local === undefined) {
    throw new Error(`missing test register local: ${reg}`);
  }

  return local;
}

function unsupported(message: string): never {
  throw new Error(`unsupported emit test hook: ${message}`);
}

function countOpcode(opcodes: readonly number[], opcode: number): number {
  return opcodes.filter((entry) => entry === opcode).length;
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
