import { assert } from "#common/assert.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { FunctionType } from "./function-type.js";
import type { FunctionDefinition } from "./functions.js";
import type { TableRef } from "./refs.js";

export interface ModuleBindings {
  readonly functionIndex: (definition: FunctionDefinition) => number;
  readonly typeIndex: (type: FunctionType) => number;
  readonly tableIndex: (ref: TableRef) => number;
  readonly resourceIndex: (ref: ResourceRef) => number;
}

type ModuleBindingIndices = Readonly<{
  functionDefinitions: ReadonlyMap<FunctionDefinition, number>;
  types: ReadonlyMap<FunctionType, number>;
  tables: ReadonlyMap<TableRef, number>;
  resources: ReadonlyMap<ResourceRef, number>;
}>;

export function createModuleBindings(indices: ModuleBindingIndices): ModuleBindings {
  return {
    functionIndex(definition) {
      const index = indices.functionDefinitions.get(definition);

      assert(index !== undefined, `missing resolved function ${definition.ref.id}`);
      return index;
    },
    typeIndex(type) {
      const index = indices.types.get(type);

      assert(index !== undefined, "missing resolved indirect call type");
      return index;
    },
    tableIndex(ref) {
      const index = indices.tables.get(ref);

      assert(index !== undefined, `missing resolved table ${ref.id}`);
      return index;
    },
    resourceIndex(ref) {
      const index = indices.resources.get(ref);

      assert(index !== undefined, `missing resolved resource ${ref.id}`);
      return index;
    }
  };
}
