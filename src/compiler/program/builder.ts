import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { WasmTableLimits } from "#compiler/encoder/module.js";
import type { StorageEffects } from "#compiler/ir/effects.js";
import { Declarations } from "./declarations.js";
import {
  type BuildFunction,
  FunctionDefinition
} from "./functions.js";
import {
  FunctionImport,
  type FunctionImportDeclaration
} from "./imports.js";
import { linkProgram } from "./link.js";
import type { FunctionType } from "./function-type.js";
import type {
  FunctionDeclaration,
  FunctionExport,
  Program,
  TableImport
} from "./model.js";
import type { FunctionRef } from "./refs.js";
import type { ProgramResources } from "./resources.js";
import {
  validateLinkedProgram,
  validateProgramDeclarations
} from "./validate.js";

export type { Program, ProgramFunction } from "./model.js";

export class ProgramBuilder {
  readonly #tables = new Declarations<TableImport>();
  readonly #functions = new Declarations<FunctionDeclaration>();
  readonly #exports = new Declarations<FunctionExport>();
  readonly #owner = {};
  readonly #resources: ProgramResources;
  #closing = false;
  #finished = false;

  constructor(resources: ProgramResources) {
    this.#resources = resources;
  }

  importTable(declaration: TableImport): void {
    this.#assertOpen();

    this.#tables.add({
      ...declaration,
      limits: copyTableLimits(declaration.limits)
    });
  }

  importFunction(declaration: FunctionImportDeclaration): FunctionImport {
    this.#assertOpen();
    const imported = new FunctionImport(declaration, this.#owner);

    this.#functions.add(imported);
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
        resources: this.#resources,
        tables: this.#tables.all(),
        functions: this.#functions.all(),
        exports: this.#exports.all()
      };

      if (buildDefinition.validation) {
        validateProgramDeclarations(declarations);
      }
      const program = linkProgram(declarations);

      if (buildDefinition.validation) {
        validateLinkedProgram(program);
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

function copyTableLimits(limits: WasmTableLimits): WasmTableLimits {
  return limits.maxElements === undefined
    ? { minElements: limits.minElements }
    : { minElements: limits.minElements, maxElements: limits.maxElements };
}
