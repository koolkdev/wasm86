import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { WasmLocalScratchAllocator } from "#backends/wasm/encoder/local-scratch.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { emitIrExpressionBlockToWasm } from "#backends/wasm/codegen/emit.js";
import { cleanValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { IrExprBlock, IrStorageExpr } from "#backends/wasm/codegen/expressions.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { createJitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import { planJitExpressionValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import type { Reg32 } from "#x86/isa/types.js";

export type EmitPlannedExpressionOptions = Readonly<{
  cloneWriteTargetsForNotification?: boolean;
}>;

export function emitPlannedExpression(
  block: IrExprBlock,
  options: EmitPlannedExpressionOptions = {}
): readonly number[] {
  const body = new WasmFunctionBodyEncoder();
  const scratch = new WasmLocalScratchAllocator(body);
  const sinkLocal = body.addLocal(wasmValueType.i32);
  const cachePlan = planJitExpressionValueCache({ operands: [] }, block);
  const valueCache = createJitValueCacheRuntime(body, cachePlan);

  emitIrExpressionBlockToWasm(block, {
    body,
    scratch,
    valueCache,
    emitGet: (source) => {
      if (source.kind !== "reg") {
        throw new Error(`unsupported test source: ${source.kind}`);
      }

      body.i32Const(registerSeed(source.reg));
      return cleanValueWidth(32);
    },
    emitSet: (target, value, accessWidth, helpers) => {
      helpers.emitValue(value);
      body.localSet(sinkLocal);
      valueCache?.notifyWrite(
        options.cloneWriteTargetsForNotification === true ? cloneStorage(target) : target,
        accessWidth
      );
    },
    emitAddress: () => {
      throw new Error("test address emission is not implemented");
    },
    emitSetFlags: () => {},
    emitMaterializeFlags: () => {},
    emitBoundaryFlags: () => {},
    emitAluFlagsCondition: () => {
      body.i32Const(0);
    },
    emitFlagProducerCondition: () => {
      body.i32Const(0);
    },
    emitNext: () => {},
    emitNextEip: () => {
      body.i32Const(0);
    },
    emitJump: (target, helpers) => {
      helpers.emitValue(target);
      body.localSet(sinkLocal);
    },
    emitConditionalJump: (condition, taken, notTaken, helpers) => {
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

  scratch.assertClear();
  body.end();
  return wasmBodyOpcodes(body.encode());
}

function cloneStorage(storage: IrStorageExpr): IrStorageExpr {
  switch (storage.kind) {
    case "reg":
      return { kind: "reg", reg: storage.reg };
    case "operand":
      return { kind: "operand", index: storage.index };
    case "mem":
      return { kind: "mem", address: storage.address };
  }
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
