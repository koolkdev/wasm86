import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { WasmMemoryLimits } from "#compiler/encoder/memory.js";
import type { WasmTableLimits } from "#compiler/encoder/module.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import { Declarations } from "./declarations.js";
import {
  type BuildFunction,
  FunctionDefinition
} from "./functions.js";
import type { LegacyFunctionDeclaration } from "./legacy-body.js";
import { linkProgram } from "./link.js";
import type { FunctionType } from "./function-type.js";
import type {
  FunctionDeclaration,
  FunctionExport,
  InternalGlobal,
  LegacyFunction,
  MemoryImport,
  Program,
  Signature,
  TableImport
} from "./model.js";
import type { FunctionRef, SignatureRef } from "./refs.js";
import {
  validateProgram,
  validateProgramDeclarations
} from "./validate.js";

export type { Program, ProgramFunction } from "./model.js";

export class ProgramBuilder {
  readonly #signatures = new Declarations<Signature>();
  readonly #memories = new Declarations<MemoryImport>();
  readonly #tables = new Declarations<TableImport>();
  readonly #globals = new Declarations<InternalGlobal>();
  readonly #functions = new Declarations<FunctionDeclaration>();
  readonly #exports = new Declarations<FunctionExport>();
  readonly #owner = {};
  #closing = false;
  #finished = false;

  // Explicit signatures exist only for raw legacyFunction bodies.
  signature(declaration: Signature): SignatureRef {
    this.#assertOpen();

    assert(
      this.#signatures.find((signature) => signature.type === declaration.type) === undefined,
      "function type already has a program signature"
    );

    this.#signatures.add({
      ref: declaration.ref,
      type: declaration.type
    });
    return declaration.ref;
  }

  importMemory(declaration: MemoryImport): void {
    this.#assertOpen();
    assert(
      this.#memories.find(
        (memory) =>
          memory.moduleName === declaration.moduleName &&
          memory.name === declaration.name
      ) === undefined,
      `duplicate program memory import: ${declaration.moduleName}.${declaration.name}`
    );

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

  global(declaration: InternalGlobal): void {
    this.#assertOpen();

    this.#globals.add({ ...declaration });
  }

  legacyFunction(declaration: LegacyFunctionDeclaration): FunctionRef {
    this.#assertOpen();
    const fn = normalizeLegacyFunction(declaration);

    this.#functions.add(fn);
    return fn.ref;
  }

  defineFunction(
    declaration: Readonly<{
      ref: FunctionRef;
      type: FunctionType;
      effects: StorageEffects;
    }>,
    build: BuildFunction
  ): FunctionDefinition {
    this.#assertOpen();
    const definition = new FunctionDefinition({
      ref: declaration.ref,
      type: declaration.type,
      effects: declaration.effects,
      owner: this.#owner,
      build
    });

    this.#functions.add(definition);
    return definition;
  }

  exportFunction(declaration: FunctionExport): void {
    this.#assertOpen();

    this.#exports.add({
      ref: declaration.ref,
      name: declaration.name,
      target: declaration.target
    });
  }

  finish(): Program {
    this.#assertOpen();
    this.#closing = true;
    try {
      const declarations = {
        owner: this.#owner,
        signatures: this.#signatures.all(),
        memories: this.#memories.all(),
        tables: this.#tables.all(),
        globals: this.#globals.all(),
        functions: this.#functions.all(),
        exports: this.#exports.all()
      };

      if (buildDefinition.validation) {
        validateProgramDeclarations(declarations);
      }
      const program = linkProgram(declarations);

      if (buildDefinition.validation) {
        validateProgram(program);
      }
      this.#finished = true;
      return program;
    } finally {
      this.#closing = false;
    }
  }

  #assertOpen(): void {
    assert(!this.#finished, "cannot modify a finished program");
    assert(!this.#closing, "cannot modify a program while it is closing");
  }
}

function normalizeLegacyFunction(declaration: LegacyFunctionDeclaration): LegacyFunction {
  const effects = declaration.effects ?? "world";
  const callTargets = unique(
    declaration.calls.filter((call): call is FunctionDefinition =>
      call instanceof FunctionDefinition
    )
  );

  return {
    kind: "legacy",
    ref: declaration.ref,
    signature: declaration.signature,
    calls: unique(declaration.calls.map((call) =>
      call instanceof FunctionDefinition ? call.ref : call
    )),
    callTargets,
    indirectTypes: [],
    resources: [...declaration.resources],
    globals: [...declaration.globals],
    tables: [...declaration.tables],
    irBlocks: declaration.irBlocks.map((entry) => ({ ...entry })),
    effects,
    eliminable: false,
    build: declaration.build
  };
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
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
