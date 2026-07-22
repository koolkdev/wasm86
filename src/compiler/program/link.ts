import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type {
  DirectFunctionTarget,
  Invocation
} from "#compiler/ir/invocation.js";
import { Declarations } from "./declarations.js";
import { closeFunctions, type FunctionClosure } from "./function-closure.js";
import type { FunctionType } from "./function-type.js";
import { FunctionDefinition } from "./functions.js";
import { FunctionImport } from "./imports.js";
import type {
  FunctionDeclaration,
  FunctionExport,
  Program,
  ProgramData,
  ProgramFunction,
  TableImport
} from "./model.js";
import type { TableRef } from "./refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { MemoryImport, ProgramResources } from "./resources.js";
import {
  validateProgramFunctionDeclaration
} from "./validate.js";

export type LinkProgramOptions = Readonly<{
  owner: object;
  resources: ProgramResources;
  tables: readonly TableImport[];
  functions: readonly FunctionDeclaration[];
  exports: readonly FunctionExport[];
}>;

export function linkProgram(options: LinkProgramOptions): Program {
  const declaredImports = options.functions.filter(isFunctionImport);
  const roots = options.functions.filter(isFunctionDefinition);
  const declarations = collectFunctionDeclarations(options);

  const liveImports = new Set<FunctionImport>();
  const closure = closeFunctions({
    owner: options.owner,
    roots,
    declareFunction: (definition) => {
      declareFunction(options, declarations, definition);
    },
    retainFunctionImport: (imported) => {
      retainFunctionImport(options, declarations, liveImports, imported);
    }
  });
  const functionImports = declaredImports.filter((imported) =>
    liveImports.has(imported)
  );
  const functions = linkFunctions(closure);
  const functionTypes = collectProgramFunctionTypes(
    functions,
    functionImports
  );
  const memoryImports = collectMemoryImports(options.resources, functions);

  const program: ProgramData = {
    functionTypes,
    memoryImports,
    functionImports,
    tables: options.tables,
    functions,
    exports: options.exports
  };

  return program as Program;
}

function collectMemoryImports(
  resources: ProgramResources,
  functions: readonly ProgramFunction[]
): readonly MemoryImport[] {
  const known = new Set(resources.memoryImports.map((memory) => memory.ref));
  const used = new Set<ResourceRef>();

  for (const fn of functions) {
    for (const resource of fn.resources) {
      assert(
        known.has(resource),
        `unknown program resource ${resource.id} used by function ${fn.ref.id}`
      );
      used.add(resource);
    }
  }
  return resources.memoryImports
    .filter((memory) => used.has(memory.ref));
}

function retainFunctionImport(
  options: LinkProgramOptions,
  declarations: Declarations<FunctionDeclaration>,
  liveImports: Set<FunctionImport>,
  imported: FunctionImport
): void {
  assert(
    imported.isAvailableTo(options.owner),
    `function ${imported.ref.id} belongs to another program`
  );
  assert(
    declarations.get(imported.ref) === imported,
    `unknown program function import ${imported.ref.id}`
  );
  liveImports.add(imported);
}

function linkFunctions(
  closure: FunctionClosure
): readonly ProgramFunction[] {
  return [...closure.functions].map(([definition, closed]): ProgramFunction => {
    const { body, placement } = closed;
    const invocations = liveInvocations(placement.analysis);
    const directTargets: DirectFunctionTarget[] = [];
    const indirectTypes: FunctionType[] = [];
    const tables: TableRef[] = [];

    for (const invocation of invocations) {
      const references = invocation.target.references;

      directTargets.push(...references.functions);
      indirectTypes.push(...references.types);
      tables.push(...references.tables);
    }
    const resources = resourcesUsedBy(placement.analysis);

    return {
      ref: definition.ref,
      type: definition.type,
      effects: definition.effects,
      directTargets: unique(directTargets),
      indirectTypes: unique(indirectTypes),
      resources,
      tables: unique(tables),
      body,
      placement
    };
  });
}

function collectProgramFunctionTypes(
  functions: readonly ProgramFunction[],
  functionImports: readonly FunctionImport[]
): readonly FunctionType[] {
  return unique([
    ...functions.map((fn) => fn.type),
    ...functionImports.map((fn) => fn.type),
    ...functions.flatMap((fn) => fn.indirectTypes)
  ]);
}

function collectFunctionDeclarations(
  options: LinkProgramOptions
): Declarations<FunctionDeclaration> {
  const declarations = new Declarations<FunctionDeclaration>();

  for (const declaration of options.functions) {
    declarations.add(declaration);
  }
  return declarations;
}

function declareFunction(
  options: LinkProgramOptions,
  declarations: Declarations<FunctionDeclaration>,
  definition: FunctionDefinition
): void {
  const existing = declarations.get(definition.ref);

  if (existing === definition) {
    return;
  }
  if (buildDefinition.validation) {
    validateProgramFunctionDeclaration(
      options,
      declarations.all(),
      definition
    );
  }
  declarations.add(definition);
}

function resourcesUsedBy(analysis: BodyAnalysis): readonly ResourceRef[] {
  const resources: ResourceRef[] = [];

  for (const { operation } of analysis.operations()) {
    if (!analysis.operationMustExecute(operation)) {
      continue;
    }
    resources.push(...operation.referencedResources);
  }
  return unique(resources);
}

function liveInvocations(
  analysis: BodyAnalysis
): readonly Invocation[] {
  return analysis.invocations()
    .filter((site) => analysis.invocationMustExecute(site))
    .map((site) => site.invocation);
}

function isFunctionDefinition(
  declaration: FunctionDeclaration
): declaration is FunctionDefinition {
  return declaration instanceof FunctionDefinition;
}

function isFunctionImport(
  declaration: FunctionDeclaration
): declaration is FunctionImport {
  return declaration instanceof FunctionImport;
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}
