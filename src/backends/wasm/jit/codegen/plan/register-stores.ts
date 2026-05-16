import { reg32, type OperandWidth, type Reg32 } from "#x86/isa/types.js";
import {
  jitInputReg32Value
} from "#backends/wasm/jit/ir/values/builders.js";
import { valuesEqual } from "#backends/wasm/jit/ir/values/equality.js";
import { simplifyValue } from "#backends/wasm/jit/ir/values/simplify.js";
import type { JitValue } from "#backends/wasm/jit/ir/values/types.js";
import type { JitValueStateSnapshot } from "#backends/wasm/jit/state/value-state.js";
import type { ExitStore, StoreTarget } from "./exit-stores.js";

export function registerStores(
  snapshot: JitValueStateSnapshot,
  regs: readonly Reg32[] = reg32
): readonly ExitStore[] {
  return regs.flatMap((reg) => {
    const store = registerStore(snapshot, reg);

    return store === undefined ? [] : [store];
  });
}

export function registerStore(
  snapshot: JitValueStateSnapshot,
  reg: Reg32
): ExitStore | undefined {
  const value = snapshot.regs.readReg32(reg);

  if (valuesEqual(value, jitInputReg32Value(reg))) {
    return undefined;
  }

  return narrowRegisterStore(reg, value) ?? {
    target: { kind: "reg32", reg },
    value
  };
}

function narrowRegisterStore(reg: Reg32, value: JitValue): ExitStore | undefined {
  const simplified = simplifyValue(value);

  if (simplified.kind !== "insertBits" || !isInputReg32(simplified.base, reg)) {
    return undefined;
  }

  const target = regPartTarget(reg, simplified.bitOffset, simplified.width);

  return target === undefined
    ? undefined
    : {
        target,
        value: simplified.value
      };
}

function regPartTarget(
  reg: Reg32,
  bitOffset: number,
  width: OperandWidth
): StoreTarget | undefined {
  if (!isLegalRegPart(bitOffset, width)) {
    return undefined;
  }

  return { kind: "regPart", reg, bitOffset, width };
}

function isLegalRegPart(bitOffset: number, width: OperandWidth): boolean {
  switch (width) {
    case 8:
      return bitOffset === 0 || bitOffset === 8;
    case 16:
      return bitOffset === 0;
    case 32:
      return false;
  }
}

function isInputReg32(value: JitValue, reg: Reg32): boolean {
  const simplified = simplifyValue(value);

  return simplified.kind === "input" && simplified.slot.kind === "reg32" && simplified.slot.reg === reg;
}
