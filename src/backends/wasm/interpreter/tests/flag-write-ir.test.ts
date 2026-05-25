import { strictEqual } from "node:assert";
import { test } from "node:test";

import { emitInterpreterIrWithContext } from "#backends/wasm/interpreter/codegen/ir-context.js";
import { InterpreterDispatchDepths } from "#backends/wasm/interpreter/codegen/depths.js";
import type { InterpreterStateCache } from "#backends/wasm/interpreter/codegen/state-cache.js";
import { InterpreterLocals } from "#backends/wasm/interpreter/codegen/locals.js";
import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { WasmModuleEncoder } from "#backends/wasm/encoder/module.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { x86ArithmeticFlagMask } from "#x86/isa/flags.js";
import { reg32, type Reg32 } from "#x86/isa/types.js";
import type { IrBlock } from "#x86/ir/model/types.js";

test("Wasm interpreter IR generation lowers semantic flag writes", async () => {
  const run = await instantiateFlagWriteInterpreterIr();
  const preserved = x86ArithmeticFlagMask.CF | x86ArithmeticFlagMask.SF;

  strictEqual(
    run(0x100, preserved | x86ArithmeticFlagMask.AF),
    preserved | x86ArithmeticFlagMask.ZF
  );
});

async function instantiateFlagWriteInterpreterIr(): Promise<(value: number, aluFlags: number) => number> {
  const module = await WebAssembly.compile(encodeFlagWriteInterpreterIrModule());
  const instance = await WebAssembly.instantiate(module);
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("expected exported function 'run'");
  }

  return run as (value: number, aluFlags: number) => number;
}

function encodeFlagWriteInterpreterIrModule(): Uint8Array<ArrayBuffer> {
  const module = new WasmModuleEncoder();
  const typeIndex = module.addFunctionType({
    params: [wasmValueType.i32, wasmValueType.i32],
    results: [wasmValueType.i32]
  });
  const body = new WasmFunctionBodyEncoder(2);
  const scratch = new WasmLocalScratchAllocator(body);
  const locals = new InterpreterLocals(body);
  const state = createSyntheticStateCache(body);

  body.localGet(0).localSet(state.regs.eax);
  body.localGet(1).localSet(state.aluFlagsLocal);
  body.block();
  emitInterpreterIrWithContext(syntheticFlagWriteBlock(), {
    body,
    scratch,
    state,
    locals,
    exit: {
      exitLocal: locals.exit,
      labelDepth: 0
    },
    depths: new InterpreterDispatchDepths(0, 0),
    instructionLength: 1,
    operands: []
  });
  body.endBlock();
  body.localGet(state.aluFlagsLocal).end();
  scratch.assertClear();

  const functionIndex = module.addFunction(typeIndex, body);
  module.exportFunction("run", functionIndex);

  return module.encode();
}

function syntheticFlagWriteBlock(): IrBlock {
  return [
    { op: "get", dst: v(0), source: { kind: "reg", reg: "eax" }, accessWidth: 32 },
    { op: "value.project", type: "i32", dst: v(1), width: 8, value: v(0) },
    { op: "value.compare", type: "i32", operator: "eq", dst: v(2), width: 8, a: v(1), b: c32(0) },
    {
      op: "flags.write",
      cells: {
        ZF: { kind: "expr", value: v(2) },
        AF: { kind: "undef" }
      },
      conditions: {
        E: { kind: "const", type: "i32", value: 1 }
      }
    },
    { op: "next" }
  ];
}

function createSyntheticStateCache(body: WasmFunctionBodyEncoder): InterpreterStateCache {
  return {
    eipLocal: body.addLocal(wasmValueType.i32),
    aluFlagsLocal: body.addLocal(wasmValueType.i32),
    instructionCountLocal: body.addLocal(wasmValueType.i32),
    regs: Object.fromEntries(reg32.map((reg) => [reg, body.addLocal(wasmValueType.i32)])) as Record<Reg32, number>
  };
}

function v(id: number) {
  return { kind: "var" as const, id };
}

function c32(value: number) {
  return { kind: "const" as const, type: "i32" as const, value };
}
