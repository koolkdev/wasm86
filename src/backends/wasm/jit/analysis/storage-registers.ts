import type { OperandWidth, RegisterAlias, Reg32 } from "#x86/isa/types.js";
import type { StorageRef } from "#x86/ir/model/types.js";
import type { JitOperandBinding } from "#backends/wasm/jit/ir/operand-bindings.js";

export type JitRegisterAccess = Readonly<{
  reg: Reg32;
  width: OperandWidth;
  bitOffset: RegisterAlias["bitOffset"];
}>;

const fullWidth = 32;

export function jitStorageRegisterAccess(
  storage: StorageRef,
  operands: readonly JitOperandBinding[],
  accessWidth: OperandWidth = fullWidth
): JitRegisterAccess | undefined {
  switch (storage.kind) {
    case "reg":
      return { reg: storage.reg, width: accessWidth, bitOffset: 0 };
    case "operand": {
      const binding = operands[storage.index]!;

      return binding.kind === "static.reg"
        ? {
            reg: binding.alias.base,
            width: binding.alias.width,
            bitOffset: binding.alias.bitOffset
          }
        : undefined;
    }
    case "mem":
      return undefined;
  }
}

export function jitStorageReg(storage: StorageRef, operands: readonly JitOperandBinding[]): Reg32 | undefined {
  return jitStorageRegisterAccess(storage, operands)?.reg;
}
