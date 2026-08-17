import type { WasmFunctionType } from "#wasm/types.js";
import { ByteSink } from "./byte-sink.js";
import {
  encodeWasmValueType,
  wasmExternalKind,
  wasmFunctionReferenceTypeCode,
  wasmFunctionTypePrefix,
  wasmMagic,
  wasmSectionId,
  wasmVersion
} from "./format.js";
import type { EncodedWasmFunctionBody } from "./function-body.js";
import { wasmInstruction } from "./instructions.js";
import { createWasmInstructionWriter } from "./instruction-writer.js";
import type { WasmMemoryLimits } from "./memory.js";

export type WasmFunctionImport = Readonly<{
  moduleName: string;
  name: string;
  typeIndex: number;
}>;

export type WasmMemoryImport = Readonly<{
  moduleName: string;
  name: string;
  limits: WasmMemoryLimits;
}>;

export type WasmTableLimits = Readonly<{
  minElements: number;
  maxElements?: number;
}>;

export type WasmTableImport = Readonly<{
  moduleName: string;
  name: string;
  limits: WasmTableLimits;
}>;

export type WasmGlobalDefinition =
  | Readonly<{ type: "i32"; mutable: boolean; initialValue: number }>
  | Readonly<{ type: "i64"; mutable: boolean; initialValue: bigint }>;

export type WasmDefinedFunction = Readonly<{
  typeIndex: number;
  body: EncodedWasmFunctionBody;
}>;

export type WasmFunctionExport = Readonly<{
  name: string;
  functionIndex: number;
}>;

// A fully indexed Wasm module ready for serialization.
// Array order determines the corresponding Wasm index spaces.
export type WasmModuleDescription = Readonly<{
  functionTypes: readonly WasmFunctionType[];
  functionImports: readonly WasmFunctionImport[];
  memoryImports: readonly WasmMemoryImport[];
  tableImports: readonly WasmTableImport[];
  functions: readonly WasmDefinedFunction[];
  globals: readonly WasmGlobalDefinition[];
  functionExports: readonly WasmFunctionExport[];
}>;

export function encodeWasmModule(description: WasmModuleDescription): Uint8Array<ArrayBuffer> {
  const module = new ByteSink();

  module.writeBytes(wasmMagic);
  module.writeBytes(wasmVersion);
  module.writeSection(wasmSectionId.type, (section) => {
    writeTypeSection(section, description.functionTypes);
  });
  if (hasImports(description)) {
    module.writeSection(wasmSectionId.import, (section) => {
      writeImportSection(section, description);
    });
  }
  module.writeSection(wasmSectionId.function, (section) => {
    writeFunctionSection(section, description.functions);
  });
  if (description.globals.length > 0) {
    module.writeSection(wasmSectionId.global, (section) => {
      writeGlobalSection(section, description.globals);
    });
  }
  module.writeSection(wasmSectionId.export, (section) => {
    writeExportSection(section, description.functionExports);
  });
  if (hasBranchHints(description.functions)) {
    module.writeSection(wasmSectionId.custom, (section) => {
      writeBranchHintSection(section, description.functionImports.length, description.functions);
    });
  }
  module.writeSection(wasmSectionId.code, (section) => {
    writeCodeSection(section, description.functions);
  });

  return module.toBytes();
}

function hasImports(description: WasmModuleDescription): boolean {
  return (
    description.functionImports.length +
      description.memoryImports.length +
      description.tableImports.length >
    0
  );
}

function writeImportSection(section: ByteSink, description: WasmModuleDescription): void {
  section.writeVecLength(
    description.functionImports.length +
      description.memoryImports.length +
      description.tableImports.length
  );

  for (const entry of description.functionImports) {
    section.writeName(entry.moduleName);
    section.writeName(entry.name);
    section.writeByte(wasmExternalKind.function);
    section.writeU32(entry.typeIndex);
  }

  for (const entry of description.memoryImports) {
    section.writeName(entry.moduleName);
    section.writeName(entry.name);
    section.writeByte(wasmExternalKind.memory);
    writeMemoryType(section, entry.limits);
  }

  for (const entry of description.tableImports) {
    section.writeName(entry.moduleName);
    section.writeName(entry.name);
    section.writeByte(wasmExternalKind.table);
    writeTableType(section, entry.limits);
  }
}

function writeTypeSection(section: ByteSink, functionTypes: readonly WasmFunctionType[]): void {
  section.writeVecLength(functionTypes.length);

  for (const type of functionTypes) {
    section.writeByte(wasmFunctionTypePrefix);
    section.writeVecLength(type.parameters.length);
    for (const parameter of type.parameters) {
      section.writeByte(encodeWasmValueType(parameter));
    }
    section.writeVecLength(type.results.length);
    for (const result of type.results) {
      section.writeByte(encodeWasmValueType(result));
    }
  }
}

function writeFunctionSection(section: ByteSink, functions: readonly WasmDefinedFunction[]): void {
  section.writeVecLength(functions.length);

  for (const fn of functions) {
    section.writeU32(fn.typeIndex);
  }
}

function writeGlobalSection(section: ByteSink, globals: readonly WasmGlobalDefinition[]): void {
  section.writeVecLength(globals.length);

  for (const global of globals) {
    section.writeByte(encodeWasmValueType(global.type));
    section.writeByte(global.mutable ? 0x01 : 0x00);
    writeGlobalInit(section, global);
  }
}

function writeExportSection(section: ByteSink, exports: readonly WasmFunctionExport[]): void {
  section.writeVecLength(exports.length);

  for (const entry of exports) {
    section.writeName(entry.name);
    section.writeByte(wasmExternalKind.function);
    section.writeU32(entry.functionIndex);
  }
}

function writeCodeSection(section: ByteSink, functions: readonly WasmDefinedFunction[]): void {
  section.writeVecLength(functions.length);

  for (const fn of functions) {
    const bytes = fn.body.bytes;

    section.writeU32(bytes.byteLength);
    section.writeBytes(bytes);
  }
}

function hasBranchHints(functions: readonly WasmDefinedFunction[]): boolean {
  return functions.some((fn) => fn.body.branchHints.length > 0);
}

function writeBranchHintSection(
  section: ByteSink,
  functionImportCount: number,
  functions: readonly WasmDefinedFunction[]
): void {
  section.writeName("metadata.code.branch_hint");
  section.writeVecLength(functions.filter((fn) => fn.body.branchHints.length > 0).length);

  for (let bodyIndex = 0; bodyIndex < functions.length; bodyIndex += 1) {
    const fn = functions[bodyIndex];

    if (fn === undefined || fn.body.branchHints.length === 0) {
      continue;
    }

    section.writeU32(functionImportCount + bodyIndex);
    writeBranchHints(section, fn.body.branchHints);
  }
}

function writeMemoryType(section: ByteSink, limits: WasmMemoryLimits): void {
  writeResizableLimits(section, limits.minPages, limits.maxPages);
}

function writeTableType(section: ByteSink, limits: WasmTableLimits): void {
  section.writeByte(wasmFunctionReferenceTypeCode);
  writeResizableLimits(section, limits.minElements, limits.maxElements);
}

function writeResizableLimits(
  section: ByteSink,
  minimum: number,
  maximum: number | undefined
): void {
  if (maximum === undefined) {
    section.writeByte(0x00);
    section.writeU32(minimum);
    return;
  }

  section.writeByte(0x01);
  section.writeU32(minimum);
  section.writeU32(maximum);
}

function writeGlobalInit(section: ByteSink, global: WasmGlobalDefinition): void {
  const { writer } = createWasmInstructionWriter(section);

  switch (global.type) {
    case "i32":
      writer.write(wasmInstruction.i32.const, global.initialValue);
      break;
    case "i64":
      writer.write(wasmInstruction.i64.const, global.initialValue);
      break;
  }

  writer.write(wasmInstruction.control.end);
}

function writeBranchHints(section: ByteSink, hints: EncodedWasmFunctionBody["branchHints"]): void {
  section.writeVecLength(hints.length);

  for (const hint of hints) {
    section.writeU32(hint.offset);
    section.writeU32(1);
    section.writeU32(hint.value);
  }
}
