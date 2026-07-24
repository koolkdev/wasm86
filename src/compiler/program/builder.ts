import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { StorageEffects } from "#compiler/ir/effects.js";
import {
  type BuildFunction,
  FunctionDefinition
} from "#compiler/program/functions.js";
import {
  FunctionImport,
  type FunctionImportDeclaration
} from "./imports.js";
import { buildProgram, DeclarationCollection } from "./closure.js";
import type { FunctionType } from "#compiler/ir/function.js";
import type {
  FunctionDeclaration,
  Program
} from "./program.js";
import type { FunctionExport } from "./exports.js";
import type { FunctionRef } from "#compiler/ir/refs.js";
import type { ProgramResources, TableImport } from "./resources.js";
import {
  maximumWasmTableElements,
  type TableLimits
} from "./limits.js";
import { validateProgramDeclarations } from "./validate.js";

export class ProgramBuilder {
  readonly #tables = new DeclarationCollection<TableImport>();
  readonly #functions = new DeclarationCollection<FunctionDeclaration>();
  readonly #exports = new DeclarationCollection<FunctionExport>();
  readonly #externalImportNames = new Map<string, Set<string>>();
  readonly #exportNames = new Set<string>();
  readonly #owner = {};
  readonly #resources: ProgramResources;
  #closing = false;
  #finished = false;

  constructor(resources: ProgramResources) {
    this.#resources = resources;

    for (const memory of resources.memoryImports) {
      this.#recordExternalImport(memory);
    }
  }

  importTable(declaration: TableImport): void {
    this.#assertOpen();
    validateTableLimits(declaration);
    this.#validateExternalImport(declaration);

    this.#tables.add({
      ...declaration,
      limits: copyTableLimits(declaration.limits)
    });
    this.#recordExternalImport(declaration);
  }

  importFunction(declaration: FunctionImportDeclaration): FunctionImport {
    this.#assertOpen();
    this.#validateExternalImport(declaration);
    const imported = new FunctionImport(declaration, this.#owner);

    this.#functions.add(imported);
    this.#recordExternalImport(declaration);
    return imported;
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
    assert(
      declaration.name.length > 0,
      "empty program function export name"
    );
    assert(
      !this.#exportNames.has(declaration.name),
      `duplicate program export name: ${declaration.name}`
    );

    this.#exports.add({
      ref: declaration.ref,
      name: declaration.name,
      target: declaration.target
    });
    this.#exportNames.add(declaration.name);
  }

  finish(): Program {
    this.#assertOpen();
    this.#closing = true;
    try {
      const declarations = {
        owner: this.#owner,
        resources: this.#resources,
        tables: this.#tables.all(),
        functions: this.#functions.all(),
        exports: this.#exports.all()
      };

      if (buildDefinition.validation) {
        validateProgramDeclarations(declarations);
      }
      const program = buildProgram(declarations);

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

  #validateExternalImport(
    imported: Readonly<{
      ref: Readonly<{ id: string }>;
      moduleName: string;
      name: string;
    }>
  ): void {
    assert(
      imported.moduleName.length > 0,
      `program import ${imported.ref.id} has an empty external module name`
    );
    assert(
      imported.name.length > 0,
      `program import ${imported.ref.id} has an empty external field name`
    );
    assert(
      !this.#externalImportNames.get(imported.moduleName)?.has(imported.name),
      `duplicate program import external identity: ${imported.moduleName}.${imported.name}`
    );
  }

  #recordExternalImport(
    imported: Readonly<{ moduleName: string; name: string }>
  ): void {
    const names = this.#externalImportNames.get(imported.moduleName);

    if (names === undefined) {
      this.#externalImportNames.set(imported.moduleName, new Set([imported.name]));
    } else {
      names.add(imported.name);
    }
  }
}

function copyTableLimits(limits: TableLimits): TableLimits {
  return limits.maxElements === undefined
    ? { minElements: limits.minElements }
    : { minElements: limits.minElements, maxElements: limits.maxElements };
}

function validateTableLimits(table: TableImport): void {
  assert(
    Number.isInteger(table.limits.minElements) &&
      table.limits.minElements >= 0 &&
      table.limits.minElements <= maximumWasmTableElements,
    `table ${table.ref.id} minimum elements out of range: ${table.limits.minElements}`
  );
  if (table.limits.maxElements === undefined) {
    return;
  }
  assert(
    Number.isInteger(table.limits.maxElements) &&
      table.limits.maxElements >= 0 &&
      table.limits.maxElements <= maximumWasmTableElements,
    `table ${table.ref.id} maximum elements out of range: ${table.limits.maxElements}`
  );
  assert(
    table.limits.maxElements >= table.limits.minElements,
    `table ${table.ref.id} maximum elements are below its minimum`
  );
}
