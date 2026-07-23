import type { WasmMemoryLimits } from "./memory.js";
import type {
  WasmModuleDescription,
  WasmTableLimits
} from "./module.js";

export function validateModuleDescription(
  description: WasmModuleDescription
): void {
  for (const imported of description.functionImports) {
    validateFunctionTypeIndex(description.functionTypes.length, imported.typeIndex);
  }
  for (const imported of description.memoryImports) {
    validateMemoryLimits(imported.limits);
  }
  for (const imported of description.tableImports) {
    validateTableLimits(imported.limits);
  }
  for (const fn of description.functions) {
    validateFunctionTypeIndex(description.functionTypes.length, fn.typeIndex);
  }

  const functionCount = description.functionImports.length +
    description.functions.length;

  for (const exported of description.functionExports) {
    validateFunctionIndex(functionCount, exported.functionIndex);
  }
}

function validateFunctionTypeIndex(
  functionTypeCount: number,
  typeIndex: number
): void {
  if (
    !Number.isInteger(typeIndex) ||
    typeIndex < 0 ||
    typeIndex >= functionTypeCount
  ) {
    throw new RangeError(`unknown Wasm function type index: ${typeIndex}`);
  }
}

function validateFunctionIndex(
  functionCount: number,
  functionIndex: number
): void {
  if (
    !Number.isInteger(functionIndex) ||
    functionIndex < 0 ||
    functionIndex >= functionCount
  ) {
    throw new RangeError(`unknown Wasm function index: ${functionIndex}`);
  }
}

function validateMemoryLimits(limits: WasmMemoryLimits): void {
  validateU32(limits.minPages, "memory minimum pages");

  if (limits.maxPages !== undefined) {
    validateU32(limits.maxPages, "memory maximum pages");

    if (limits.maxPages < limits.minPages) {
      throw new RangeError(
        "memory maximum pages must be greater than or equal to minimum pages"
      );
    }
  }
}

function validateTableLimits(limits: WasmTableLimits): void {
  validateU32(limits.minElements, "table minimum elements");

  if (limits.maxElements !== undefined) {
    validateU32(limits.maxElements, "table maximum elements");

    if (limits.maxElements < limits.minElements) {
      throw new RangeError(
        "table maximum elements must be greater than or equal to minimum elements"
      );
    }
  }
}

function validateU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
}
