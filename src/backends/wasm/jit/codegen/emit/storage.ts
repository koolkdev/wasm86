import type { WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { JitIrContext } from "./ir-context.js";
import { emitJitSet } from "./operands.js";
import type { JitValueCacheRuntime } from "./value-local-store.js";

export function emitJitStorageSet(
  jitContext: JitIrContext,
  valueCache: JitValueCacheRuntime | undefined,
  target: IrStorageExpr,
  value: IrValueExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers
): void {
  emitJitSet(jitContext, target, value, accessWidth, helpers);
  valueCache?.notifyWrite(target, accessWidth);
}
