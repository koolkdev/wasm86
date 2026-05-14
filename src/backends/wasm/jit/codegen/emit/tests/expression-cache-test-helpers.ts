import { WasmFunctionBodyEncoder } from "#backends/wasm/encoder/function-body.js";
import { wasmValueType } from "#backends/wasm/encoder/types.js";
import { cleanValueWidth } from "#backends/wasm/codegen/value-width.js";
import type { IrExprBlock } from "#backends/wasm/codegen/expressions.js";
import { wasmBodyOpcodes } from "#backends/wasm/tests/body-opcodes.js";
import { emitJitExpressionBlock } from "#backends/wasm/jit/codegen/emit/expression-block.js";
import { createJitValueCacheRuntime } from "#backends/wasm/jit/codegen/emit/value-local-store.js";
import { planJitValueCache } from "#backends/wasm/jit/codegen/plan/value-cache.js";
import { buildJitInstructionValueTimeline } from "#backends/wasm/jit/codegen/plan/value-timeline.js";
import { planJitValueUses } from "#backends/wasm/jit/codegen/plan/value-uses.js";
import { rootExpressionPathScopes } from "#backends/wasm/jit/codegen/tests/path-scope-test-helpers.js";
import { createJitValueState } from "#backends/wasm/jit/state/value-state.js";
import type { Reg32 } from "#x86/isa/types.js";

export function emitPlannedExpression(
  block: IrExprBlock
): readonly number[] {
  const body = new WasmFunctionBodyEncoder();
  const sinkLocal = body.addLocal(wasmValueType.i32);
  const valueTimeline = buildJitInstructionValueTimeline({
    operands: [],
    expressionBlock: block,
    entryValueState: createJitValueState().snapshot()
  });
  const plannedValueUses = planJitValueUses([{
    expressionBlock: block,
    valueTimeline,
    expressionPathScopes: rootExpressionPathScopes(block),
    materializationUses: new Map()
  }]);
  const cachePlan = planJitValueCache({
    operands: [],
    valueTimeline
  }, block, plannedValueUses);
  const valueCache = createJitValueCacheRuntime(body, cachePlan);

  valueCache?.beginInstruction(0);
  emitJitExpressionBlock({
    body,
    instruction: {
      expressionBlock: block,
      valueTimeline,
      plannedValueCaptures: new Map()
    },
    valueCache,
    emitInput: (slot) => {
      if (slot.kind === "aluFlags") {
        body.i32Const(0);
        return cleanValueWidth(32);
      }

      body.i32Const(registerSeed(slot.reg));
      return cleanValueWidth(32);
    },
    emitGet: (source) => {
      if (source.kind !== "reg") {
        throw new Error(`unsupported test source: ${source.kind}`);
      }

      body.i32Const(registerSeed(source.reg));
      return cleanValueWidth(32);
    },
    emitSet: (op, helpers) => {
      helpers.emitValue(op.value);
      body.localSet(sinkLocal);
    },
    emitMemoryGuard: (op, helpers) => {
      helpers.emitValue(op.address);
      body.localSet(sinkLocal);
    },
    emitAddress: () => {
      throw new Error("test address emission is not implemented");
    },
    emitNext: () => {},
    emitNextEip: () => {
      body.i32Const(0);
      return cleanValueWidth(32);
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

  body.end();
  return wasmBodyOpcodes(body.encode());
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
