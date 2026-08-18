import { assert } from "#common/assert.js";
import { InternTable } from "#common/intern-table.js";
import type { FunctionExportRef } from "#compiler/program/exports.js";
import type { FunctionRef, ResourceRef } from "#compiler/reference.js";
import type { WasmFunctionType, WasmValueType } from "#wasm/types.js";
import type { WasmModulePlan } from "./plan.js";

export type ModuleFunctionExport = Readonly<{
  ref: FunctionExportRef;
  name: string;
  functionIndex: number;
}>;

export type WasmFunctionTypeIndices = Readonly<{
  get(type: WasmFunctionType): number | undefined;
}>;

// The sole authority for the numeric identities serialized by the encoder.
export type ModuleIndices = Readonly<{
  functionTypes: readonly WasmFunctionType[];
  functionTypeIndices: WasmFunctionTypeIndices;
  functionIndices: ReadonlyMap<FunctionRef, number>;
  memoryIndices: ReadonlyMap<ResourceRef, number>;
  functionExports: readonly ModuleFunctionExport[];
}>;

export function indexWasmModule(plan: WasmModulePlan): ModuleIndices {
  const functionTypes: WasmFunctionType[] = [];
  const functionTypeIndices = new StructuralFunctionTypeIndices();
  const addType = (type: WasmFunctionType): void => {
    const nextIndex = functionTypes.length;
    const index = functionTypeIndices.intern(type, nextIndex);

    if (index === nextIndex) {
      functionTypes.push(type);
    }
  };

  // Type order follows first use by definitions, then imports. Function index
  // order follows the Wasm import-before-definition index space.
  for (const fn of plan.functions) {
    addType(fn.type);
  }
  for (const imported of plan.functionImports) {
    addType(imported.type);
  }

  const functionIndices = new Map([
    ...plan.functionImports.map((fn, index) => [fn.ref, index] as const),
    ...plan.functions.map((fn, index) => [fn.ref, plan.functionImports.length + index] as const)
  ]);
  const functionExports = plan.exports.map((exported): ModuleFunctionExport => {
    const functionIndex = functionIndices.get(exported.target);

    assert(
      functionIndex !== undefined,
      `missing index for exported program function ${exported.target.id}`
    );
    return {
      ref: exported.ref,
      name: exported.name,
      functionIndex
    };
  });

  return {
    functionTypes,
    functionTypeIndices,
    functionIndices,
    memoryIndices: new Map(plan.memoryImports.map((memory, index) => [memory.ref, index])),
    functionExports
  };
}

class StructuralFunctionTypeIndices implements WasmFunctionTypeIndices {
  readonly #indices = new InternTable<number, WasmValueType, number>();
  readonly #cached = new WeakMap<WasmFunctionType, number>();

  get(type: WasmFunctionType): number | undefined {
    const cached = this.#cached.get(type);

    if (cached !== undefined) {
      return cached;
    }
    const index = this.#indices.get(type.parameters.length, functionTypeParts(type));

    if (index !== undefined) {
      this.#cached.set(type, index);
    }
    return index;
  }

  intern(type: WasmFunctionType, index: number): number {
    const resolved = this.#indices.intern(
      type.parameters.length,
      functionTypeParts(type),
      () => index
    );

    this.#cached.set(type, resolved);
    return resolved;
  }
}

function functionTypeParts(type: WasmFunctionType): readonly WasmValueType[] {
  // The parameter count is the trie namespace, so concatenation preserves the
  // boundary between parameter and result sequences.
  return [...type.parameters, ...type.results];
}
