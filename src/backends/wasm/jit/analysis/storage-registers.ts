import type { IrStorageExpr } from "#wasm/codegen/expressions.js";
import type { OperandWidth, RegisterAlias, Reg32 } from "#x86/types.js";
import type { StorageRef } from "#ir/model/types.js";
import { registerAlias } from "#x86/registers.js";

export type JitRegisterAccess = Readonly<{
  reg: Reg32;
  width: OperandWidth;
  bitOffset: RegisterAlias["bitOffset"];
}>;

const fullWidth = 32;

export function jitStorageRegisterAccess(
  storage: StorageRef | IrStorageExpr,
  accessWidth: OperandWidth = fullWidth
): JitRegisterAccess | undefined {
  switch (storage.kind) {
    case "reg": {
      const alias = registerAlias(storage.reg);

      return {
        reg: alias.base,
        width: alias.width === 32 ? accessWidth : alias.width,
        bitOffset: alias.bitOffset
      };
    }
    case "operand":
      return undefined;
    case "mem":
      return undefined;
  }
}
