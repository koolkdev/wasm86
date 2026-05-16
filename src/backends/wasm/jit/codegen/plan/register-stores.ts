import { reg32, type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import {
  jitInputReg32Value
} from "#backends/wasm/jit/ir/values/builders.js";
import { jitRegisterSlotForWrite } from "#backends/wasm/jit/ir/values/slots.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitRegisterSlot, JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";

export type RegisterExitStore = Readonly<{
  target: JitRegisterSlot;
  value: JitValue;
}>;

export function registerStores(
  snapshot: JitValueStateSnapshot,
  regs: readonly Reg32[] = reg32
): readonly RegisterExitStore[] {
  return regs.flatMap((reg) => {
    const store = registerStore(snapshot, reg);

    return store === undefined ? [] : [store];
  });
}

export function registerStore(
  snapshot: JitValueStateSnapshot,
  reg: Reg32
): RegisterExitStore | undefined {
  const value = snapshot.regs.readReg32(reg);

  if (valuesEqual(value, jitInputReg32Value(reg))) {
    return undefined;
  }

  return narrowRegisterStore(reg, value) ?? {
    target: { kind: "reg32", reg },
    value
  };
}

function narrowRegisterStore(reg: Reg32, value: JitValue): RegisterExitStore | undefined {
  const simplified = simplifyValue(value);

  if (simplified.kind !== "insertBits" || !isInputReg32(simplified.base, reg)) {
    return undefined;
  }

  const target = registerStoreTarget(reg, simplified.bitOffset, simplified.width);

  return target === undefined
    ? undefined
    : {
        target,
        value: simplified.value
      };
}

function registerStoreTarget(
  reg: Reg32,
  bitOffset: number,
  width: OperandWidth
): JitRegisterSlot | undefined {
  if (width === 32) {
    return undefined;
  }

  return jitRegisterSlotForWrite(reg, bitOffset, width);
}

function isInputReg32(value: JitValue, reg: Reg32): boolean {
  const simplified = simplifyValue(value);

  return simplified.kind === "input" && simplified.slot.kind === "reg32" && simplified.slot.reg === reg;
}
