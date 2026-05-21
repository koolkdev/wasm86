import { irVar } from "#x86/ir/model/refs.js";
import type { VarRef } from "#x86/ir/model/types.js";

export type IrVarAllocator = Readonly<{
  allocate(): VarRef;
}>;

export function createIrVarAllocator(): IrVarAllocator {
  let nextVarId = 0;

  return {
    allocate: () => {
      const id = nextVarId;

      nextVarId += 1;
      return irVar(id);
    }
  };
}
