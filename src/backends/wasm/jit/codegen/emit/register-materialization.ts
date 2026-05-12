import type { WasmIrEmitHelpers } from "#backends/wasm/codegen/emit.js";
import type { IrStorageExpr, IrValueExpr } from "#backends/wasm/codegen/expressions.js";
import { valueWidthIsCleanForWidth } from "#backends/wasm/codegen/value-width.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type { JitIrContext } from "./ir-context.js";
import { emitJitSet } from "./operands.js";
import type { JitValueCacheRuntime } from "./value-local-store.js";
import type { LocalRegValueSource } from "#backends/wasm/jit/state/register-values.js";

export function emitJitRegisterMaterialization(
  jitContext: JitIrContext,
  valueCache: JitValueCacheRuntime | undefined,
  target: IrStorageExpr,
  value: IrValueExpr,
  accessWidth: OperandWidth,
  helpers: WasmIrEmitHelpers
): void {
  if (accessWidth !== 32) {
    throw new Error(`JIT register materialization cannot use ${accessWidth}-bit writes`);
  }

  if (target.kind !== "reg") {
    throw new Error(`JIT register materialization cannot target ${target.kind}`);
  }

  if (!emitRegisterMaterializationFromCapturedReuseValue(jitContext, valueCache, target, value, helpers)) {
    emitJitSet(jitContext, target, value, accessWidth, helpers);
  }

  jitContext.state.regs.commitPendingReg(target.reg);
}

function emitRegisterMaterializationFromCapturedReuseValue(
  jitContext: JitIrContext,
  valueCache: JitValueCacheRuntime | undefined,
  target: Extract<IrStorageExpr, { kind: "reg" }>,
  value: IrValueExpr,
  helpers: WasmIrEmitHelpers
): boolean {
  const jitValue = valueCache?.valueForExpression(value);

  if (jitValue === undefined) {
    return false;
  }

  const captured = valueCache?.captureForReuse(jitValue, () =>
    helpers.emitValue(value)
  );

  if (captured === undefined) {
    return false;
  }

  const prefixSource: LocalRegValueSource | undefined = valueWidthIsCleanForWidth(captured.valueWidth, 32)
    ? { kind: "local", local: captured.local, width: 32, owner: captured }
    : undefined;

  jitContext.state.regs.emitWriteAlias(
    { name: target.reg, base: target.reg, bitOffset: 0, width: 32 },
    {
      ...(prefixSource === undefined ? {} : { prefixSource }),
      emitValue: () => {
        jitContext.body.localGet(captured.local);
        return captured.valueWidth;
      }
    }
  );

  if (prefixSource === undefined) {
    captured.release();
  }

  return true;
}
