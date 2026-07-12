import { assert } from "#common/assert.js";
import type { WasmMemoryLimits } from "#compiler/encoder/memory.js";
import type { WasmTableLimits } from "#compiler/encoder/module.js";
import type { WasmFunctionType } from "#compiler/encoder/types.js";
import type {
  ExportRef,
  FunctionRef,
  GlobalRef,
  ResourceRef,
  SignatureRef,
  TableRef
} from "./refs.js";
import { Declarations } from "./declarations.js";
import {
  type LegacyEffects,
  type LegacyFunctionDeclaration,
  type LegacyTraps
} from "./legacy-body.js";

type Signature = Readonly<{
  ref: SignatureRef;
  type: WasmFunctionType;
}>;

type MemoryImport = Readonly<{
  ref: ResourceRef;
  moduleName: string;
  name: string;
  limits: WasmMemoryLimits;
}>;

type TableImport = Readonly<{
  ref: TableRef;
  moduleName: string;
  name: string;
  limits: WasmTableLimits;
}>;

type FunctionExport = Readonly<{
  ref: ExportRef;
  name: string;
  target: FunctionRef;
}>;

type LegacyFunction = Readonly<{
  ref: FunctionRef;
  signature: SignatureRef;
  calls: readonly FunctionRef[];
  resources: readonly ResourceRef[];
  globals: readonly GlobalRef[];
  tables: readonly TableRef[];
  effects: LegacyEffects;
  traps: LegacyTraps;
  eliminable: false;
  build: LegacyFunctionDeclaration["build"];
}>;

declare const programBrand: unique symbol;

type ProgramData = Readonly<{
  signatures: readonly Signature[];
  memories: readonly MemoryImport[];
  tables: readonly TableImport[];
  functions: readonly LegacyFunction[];
  exports: readonly FunctionExport[];
}>;

export type Program = ProgramData & Readonly<{ [programBrand]: true }>;

export class ProgramBuilder {
  readonly #signatures = new Declarations<Signature>();
  readonly #memories = new Declarations<MemoryImport>();
  readonly #tables = new Declarations<TableImport>();
  readonly #functions = new Declarations<LegacyFunction>();
  readonly #exports = new Declarations<FunctionExport>();
  readonly #exportNames = new Set<string>();
  #finished = false;

  signature(declaration: Signature): void {
    this.#assertOpen();

    this.#signatures.add({
      ref: declaration.ref,
      type: {
        params: [...declaration.type.params],
        results: [...declaration.type.results]
      }
    });
  }

  importMemory(declaration: MemoryImport): void {
    this.#assertOpen();

    this.#memories.add({
      ...declaration,
      limits: copyMemoryLimits(declaration.limits)
    });
  }

  importTable(declaration: TableImport): void {
    this.#assertOpen();

    this.#tables.add({
      ...declaration,
      limits: copyTableLimits(declaration.limits)
    });
  }

  legacyFunction(declaration: LegacyFunctionDeclaration): FunctionRef {
    this.#assertOpen();

    const fn = normalizeLegacyFunction(declaration);

    this.#functions.add(fn);
    return fn.ref;
  }

  exportFunction(declaration: FunctionExport): void {
    this.#assertOpen();
    assert(declaration.name.length > 0, "empty program function export name");
    assert(!this.#exportNames.has(declaration.name), `duplicate program export name: ${declaration.name}`);

    this.#exports.add({
      ref: declaration.ref,
      name: declaration.name,
      target: declaration.target
    });
    this.#exportNames.add(declaration.name);
  }

  finish(): Program {
    this.#assertOpen();
    this.#assertValid();

    this.#finished = true;
    const program = {
      signatures: this.#signatures.all(),
      memories: this.#memories.all(),
      tables: this.#tables.all(),
      functions: this.#functions.all(),
      exports: this.#exports.all()
    } satisfies ProgramData;

    return program as Program;
  }

  #assertValid(): void {
    for (const fn of this.#functions) {
      assert(
        this.#signatures.has(fn.signature),
        `unknown program signature ${fn.signature.id} declared by function ${fn.ref.id}`
      );

      for (const call of fn.calls) {
        assert(
          this.#functions.has(call),
          `unknown program function ${call.id} called by function ${fn.ref.id}`
        );
      }

      for (const resource of fn.resources) {
        assert(
          this.#memories.has(resource),
          `unknown program resource ${resource.id} used by function ${fn.ref.id}`
        );
      }

      assert(fn.globals.length === 0, `unknown program global used by function ${fn.ref.id}`);

      for (const table of fn.tables) {
        assert(
          this.#tables.has(table),
          `unknown program table ${table.id} used by function ${fn.ref.id}`
        );
      }
    }

    for (const exported of this.#exports) {
      assert(
        this.#functions.has(exported.target),
        `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
      );
    }
  }

  #assertOpen(): void {
    assert(!this.#finished, "cannot modify a finished program");
  }
}

function normalizeLegacyFunction(declaration: LegacyFunctionDeclaration): LegacyFunction {
  const effects = declaration.effects ?? "world";
  const traps = declaration.traps ?? "may";

  assert(effects === "none" || effects === "world", `unknown legacy function effects: ${effects}`);
  assert(traps === "never" || traps === "may", `unknown legacy function trap behavior: ${traps}`);
  return {
    ref: declaration.ref,
    signature: declaration.signature,
    calls: [...declaration.calls],
    resources: [...declaration.resources],
    globals: [...declaration.globals],
    tables: [...declaration.tables],
    effects,
    traps,
    eliminable: false,
    build: declaration.build
  };
}

function copyMemoryLimits(limits: WasmMemoryLimits): WasmMemoryLimits {
  return limits.maxPages === undefined
    ? { minPages: limits.minPages }
    : { minPages: limits.minPages, maxPages: limits.maxPages };
}

function copyTableLimits(limits: WasmTableLimits): WasmTableLimits {
  return limits.maxElements === undefined
    ? { minElements: limits.minElements }
    : { minElements: limits.minElements, maxElements: limits.maxElements };
}
