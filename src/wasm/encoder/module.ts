import { ByteSink } from "./byte-sink.js";
import { WasmFunctionBodyEncoder, type EncodedBranchHint, type EncodedWasmFunctionBody } from "./function-body.js";
import { validateMemoryLimits, type WasmMemoryLimits } from "./memory.js";
import {
  wasmExternalKind,
  wasmFunctionTypePrefix,
  wasmMagic,
  wasmSectionId,
  wasmValueType,
  wasmVersion,
  type WasmFunctionType
} from "./types.js";

export class WasmModuleEncoder {
  readonly #types: WasmFunctionType[] = [];
  readonly #memoryImports: MemoryImport[] = [];
  readonly #tableImports: TableImport[] = [];
  readonly #functions: number[] = [];
  readonly #exports: FunctionExport[] = [];
  readonly #bodies: EncodedWasmFunctionBody[] = [];

  addFunctionType(type: WasmFunctionType): number {
    const index = this.#types.length;
    this.#types.push(type);
    return index;
  }

  importMemory(moduleName: string, name: string, limits: WasmMemoryLimits): number {
    validateMemoryLimits(limits);

    const memoryIndex = this.#memoryImports.length;
    this.#memoryImports.push({ moduleName, name, limits });
    return memoryIndex;
  }

  importTable(moduleName: string, name: string, limits: WasmTableLimits): number {
    validateTableLimits(limits);

    const tableIndex = this.#tableImports.length;
    this.#tableImports.push({ moduleName, name, limits });
    return tableIndex;
  }

  addFunction(typeIndex: number, body: WasmFunctionBodyEncoder): number {
    if (!Number.isInteger(typeIndex) || typeIndex < 0 || typeIndex >= this.#types.length) {
      throw new RangeError(`unknown Wasm function type index: ${typeIndex}`);
    }

    const functionIndex = this.#functions.length;
    this.#functions.push(typeIndex);
    this.#bodies.push(body.encodeWithMetadata());
    return functionIndex;
  }

  exportFunction(name: string, functionIndex: number): void {
    if (!Number.isInteger(functionIndex) || functionIndex < 0 || functionIndex >= this.#functions.length) {
      throw new RangeError(`unknown Wasm function index: ${functionIndex}`);
    }

    this.#exports.push({ name, functionIndex });
  }

  encode(): Uint8Array<ArrayBuffer> {
    const module = new ByteSink();

    module.writeBytes(wasmMagic);
    module.writeBytes(wasmVersion);
    module.writeSection(wasmSectionId.type, (section) => this.#writeTypeSection(section));
    if (this.#hasImports()) {
      module.writeSection(wasmSectionId.import, (section) => this.#writeImportSection(section));
    }
    module.writeSection(wasmSectionId.function, (section) => this.#writeFunctionSection(section));
    module.writeSection(wasmSectionId.export, (section) => this.#writeExportSection(section));
    if (this.#hasBranchHints()) {
      module.writeSection(wasmSectionId.custom, (section) => this.#writeBranchHintSection(section));
    }
    module.writeSection(wasmSectionId.code, (section) => this.#writeCodeSection(section));

    return module.toBytes();
  }

  #writeImportSection(section: ByteSink): void {
    section.writeVecLength(this.#memoryImports.length + this.#tableImports.length);

    for (const entry of this.#memoryImports) {
      section.writeName(entry.moduleName);
      section.writeName(entry.name);
      section.writeByte(wasmExternalKind.memory);
      writeMemoryType(section, entry.limits);
    }

    for (const entry of this.#tableImports) {
      section.writeName(entry.moduleName);
      section.writeName(entry.name);
      section.writeByte(wasmExternalKind.table);
      writeTableType(section, entry.limits);
    }
  }

  #writeTypeSection(section: ByteSink): void {
    section.writeVecLength(this.#types.length);

    for (const type of this.#types) {
      section.writeByte(wasmFunctionTypePrefix);
      section.writeVecLength(type.params.length);
      section.writeBytes(type.params);
      section.writeVecLength(type.results.length);
      section.writeBytes(type.results);
    }
  }

  #writeFunctionSection(section: ByteSink): void {
    section.writeVecLength(this.#functions.length);

    for (const typeIndex of this.#functions) {
      section.writeU32(typeIndex);
    }
  }

  #writeExportSection(section: ByteSink): void {
    section.writeVecLength(this.#exports.length);

    for (const entry of this.#exports) {
      section.writeName(entry.name);
      section.writeByte(wasmExternalKind.function);
      section.writeU32(entry.functionIndex);
    }
  }

  #writeCodeSection(section: ByteSink): void {
    section.writeVecLength(this.#bodies.length);

    for (const body of this.#bodies) {
      section.writeU32(body.bytes.byteLength);
      section.writeBytes(body.bytes);
    }
  }

  #hasBranchHints(): boolean {
    return this.#bodies.some((body) => body.branchHints.length > 0);
  }

  #hasImports(): boolean {
    return this.#memoryImports.length + this.#tableImports.length > 0;
  }

  #writeBranchHintSection(section: ByteSink): void {
    section.writeName("metadata.code.branch_hint");
    section.writeVecLength(this.#bodies.filter((body) => body.branchHints.length > 0).length);

    for (let functionIndex = 0; functionIndex < this.#bodies.length; functionIndex += 1) {
      const body = this.#bodies[functionIndex];

      if (body === undefined || body.branchHints.length === 0) {
        continue;
      }

      section.writeU32(functionIndex);
      writeBranchHints(section, body.branchHints);
    }
  }
}

type MemoryImport = Readonly<{
  moduleName: string;
  name: string;
  limits: WasmMemoryLimits;
}>;

export type WasmTableLimits = Readonly<{
  minElements: number;
  maxElements?: number;
}>;

type TableImport = Readonly<{
  moduleName: string;
  name: string;
  limits: WasmTableLimits;
}>;

type FunctionExport = Readonly<{
  name: string;
  functionIndex: number;
}>;

function writeMemoryType(section: ByteSink, limits: WasmMemoryLimits): void {
  writeResizableLimits(section, limits.minPages, limits.maxPages);
}

function writeTableType(section: ByteSink, limits: WasmTableLimits): void {
  section.writeByte(wasmValueType.funcref);
  writeResizableLimits(section, limits.minElements, limits.maxElements);
}

function writeResizableLimits(section: ByteSink, minimum: number, maximum: number | undefined): void {
  if (maximum === undefined) {
    section.writeByte(0x00);
    section.writeU32(minimum);
    return;
  }

  section.writeByte(0x01);
  section.writeU32(minimum);
  section.writeU32(maximum);
}

function validateTableLimits(limits: WasmTableLimits): void {
  validateU32(limits.minElements, "table minimum elements");

  if (limits.maxElements !== undefined) {
    validateU32(limits.maxElements, "table maximum elements");

    if (limits.maxElements < limits.minElements) {
      throw new RangeError("table maximum elements must be greater than or equal to minimum elements");
    }
  }
}

function validateU32(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`${label} out of range: ${value}`);
  }
}

function writeBranchHints(section: ByteSink, hints: readonly EncodedBranchHint[]): void {
  section.writeVecLength(hints.length);

  for (const hint of hints) {
    section.writeU32(hint.offset);
    section.writeU32(1);
    section.writeU32(hint.value);
  }
}
