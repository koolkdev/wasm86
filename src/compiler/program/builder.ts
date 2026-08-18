import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { StorageEffects } from "#compiler/function/storage.js";
import type { FunctionType } from "#compiler/function/type.js";
import { type BuildFunction, FunctionDefinition } from "#compiler/program/functions.js";
import { FunctionImport, type FunctionImportDeclaration } from "./imports.js";
import type { FunctionDeclaration, Program, ProgramDeclarations } from "./program.js";
import type { FunctionExport } from "./exports.js";
import type { FunctionRef } from "#compiler/reference.js";
import type { ProgramResources } from "./resources.js";
import { validateProgramDeclarationEffects, validateProgramExportTargets } from "./validate.js";

export class ProgramBuilder {
  readonly #functions = new DeclarationCollection<FunctionDeclaration>();
  readonly #exports = new DeclarationCollection<FunctionExport>();
  readonly #externalImportNames = new Map<string, Set<string>>();
  readonly #exportNames = new Set<string>();
  readonly #owner = {};
  readonly #resources: ProgramResources;
  #finished = false;

  constructor(resources: ProgramResources) {
    this.#resources = resources;

    for (const memory of resources.memoryImports) {
      this.#recordExternalImport(memory);
    }
  }

  importFunction<Type extends FunctionType>(
    declaration: FunctionImportDeclaration<Type>
  ): FunctionImport<Type> {
    this.#assertOpen();
    this.#validateExternalImport(declaration);
    const imported = new FunctionImport(declaration, this.#owner);

    this.#functions.add(imported);
    this.#recordExternalImport(declaration);
    return imported;
  }

  defineFunction<Type extends FunctionType>(
    declaration: Readonly<{
      ref: FunctionRef;
      type: Type;
      effects: StorageEffects;
    }>,
    build: BuildFunction<NoInfer<Type>>
  ): FunctionDefinition<Type> {
    this.#assertOpen();
    const definition = new FunctionDefinition({
      ref: declaration.ref,
      type: declaration.type,
      effects: declaration.effects,
      owner: this.#owner,
      buildStability: "dynamic",
      build
    });

    this.#functions.add(definition);
    return definition;
  }

  exportFunction(declaration: FunctionExport): void {
    this.#assertOpen();
    assert(declaration.name.length > 0, "empty program function export name");
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
    const declarations: ProgramDeclarations = {
      owner: this.#owner,
      resources: { memoryImports: [...this.#resources.memoryImports] },
      functions: this.#functions.all(),
      exports: this.#exports.all()
    };

    validateProgramExportTargets(declarations);
    if (buildDefinition.validation) {
      validateProgramDeclarationEffects(declarations);
    }

    this.#finished = true;
    return declarations as Program;
  }

  #assertOpen(): void {
    assert(!this.#finished, "cannot modify a finished program");
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

  #recordExternalImport(imported: Readonly<{ moduleName: string; name: string }>): void {
    const names = this.#externalImportNames.get(imported.moduleName);

    if (names === undefined) {
      this.#externalImportNames.set(imported.moduleName, new Set([imported.name]));
    } else {
      names.add(imported.name);
    }
  }
}

type Declaration = Readonly<{ ref: Readonly<{ kind: string; id: string }> }>;

class DeclarationCollection<T extends Declaration> {
  readonly #ordered: T[] = [];
  readonly #byRef = new Map<T["ref"], T>();
  readonly #byId = new Map<string, T>();

  add(declaration: T): void {
    const { ref } = declaration;

    assert(!this.#byRef.has(ref), `duplicate program ${ref.kind} declaration: ${ref.id}`);
    assert(!this.#byId.has(ref.id), `duplicate program ${ref.kind} identity: ${ref.id}`);
    this.#ordered.push(declaration);
    this.#byRef.set(ref, declaration);
    this.#byId.set(ref.id, declaration);
  }

  all(): readonly T[] {
    return [...this.#ordered];
  }
}
