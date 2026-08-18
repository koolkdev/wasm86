import { assert } from "#common/assert.js";
import type { WasmFunctionBindings } from "#compiler/wasm/emit/bindings.js";
import type { WasmFunctionType } from "#wasm/types.js";
import type { ModuleIndices } from "./indices.js";

// Shared by every function body in one module. Symbols stay unresolved until
// an emitted instruction or module entry needs its numeric identity.
export interface ModuleBindings extends WasmFunctionBindings {
  readonly functionTypeIndex: (type: WasmFunctionType) => number;
}

export function createModuleBindings(indices: ModuleIndices): ModuleBindings {
  return {
    functionIndex(ref) {
      const index = indices.functionIndices.get(ref);

      assert(index !== undefined, `missing resolved function ${ref.id}`);
      return index;
    },
    functionTypeIndex(type) {
      const index = indices.functionTypeIndices.get(type);

      assert(index !== undefined, "missing resolved function type");
      return index;
    },
    memoryIndex(ref) {
      const index = indices.memoryIndices.get(ref);

      assert(index !== undefined, `missing resolved memory resource ${ref.id}`);
      return index;
    }
  };
}
