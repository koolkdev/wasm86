import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type { Invocation } from "#compiler/ir/invocation.js";
import { placeBody, type BodyPlacement } from "#compiler/placement/place.js";
import type { IrBlock } from "#ir/block.js";
import { Declarations } from "./declarations.js";
import { closeFunctions, type FunctionClosure } from "./function-closure.js";
import type { FunctionType } from "./function-type.js";
import { FunctionDefinition } from "./functions.js";
import type {
  DefinedFunction,
  FunctionDeclaration,
  FunctionExport,
  InternalGlobal,
  LegacyFunction,
  Program,
  ProgramData,
  ProgramFunction,
  Signature,
  TableImport
} from "./model.js";
import type { TableRef } from "./refs.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { MemoryImport, ProgramResources } from "./resources.js";
import {
  validateLinkedProgramFunctions,
  validateProgramFunctionDeclaration
} from "./validate.js";

export type LinkProgramOptions = Readonly<{
  owner: object;
  resources: ProgramResources;
  signatures: readonly Signature[];
  tables: readonly TableImport[];
  globals: readonly InternalGlobal[];
  functions: readonly FunctionDeclaration[];
  exports: readonly FunctionExport[];
}>;

export function linkProgram(options: LinkProgramOptions): Program {
  const declaredLegacy = options.functions.filter(isLegacyFunction);
  const roots = options.functions.filter(isFunctionDefinition);
  const declarations = collectFunctionDeclarations(options, declaredLegacy);

  const placements = new Map<IrBlock, BodyPlacement>();
  const legacy = placeLegacyFunctions(declaredLegacy, placements);
  const closure = closeFunctions({
    owner: options.owner,
    roots,
    declaredFunctions: declaredLegacy.flatMap((fn) => fn.callTargets),
    rootPlacements: legacy.rootPlacements,
    declareFunction: (definition) => {
      declareFunction(options, declarations, definition);
    }
  });
  const defined = linkDefinedFunctions(
    closure,
    placements
  );
  const functions: readonly ProgramFunction[] = [...legacy.functions, ...defined];
  const functionTypes = collectProgramFunctionTypes(
    defined,
    legacy.functions,
    options.signatures
  );
  const memoryImports = collectMemoryImports(options.resources, functions);

  if (buildDefinition.validation) {
    validateLinkedProgramFunctions(declarations.all(), functions);
  }
  const program: ProgramData = {
    functionTypes,
    signatures: options.signatures,
    memoryImports,
    tables: options.tables,
    globals: options.globals,
    functions,
    exports: options.exports,
    placements
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

type PlacedLegacyFunctions = Readonly<{
  functions: readonly LegacyFunction[];
  rootPlacements: readonly BodyPlacement[];
}>;

function placeLegacyFunctions(
  declarations: readonly LegacyFunction[],
  placements: Map<IrBlock, BodyPlacement>
): PlacedLegacyFunctions {
  const rootPlacements: BodyPlacement[] = [];
  const functions = declarations.map((fn): LegacyFunction => {
    const liveCalls: FunctionDefinition[] = [];
    const liveIndirectTypes = [...fn.indirectTypes];
    const liveTables = [...fn.tables];

    for (const entry of fn.irBlocks) {
      const placement = placeBody(entry.block, {
        allowImplicitEntryFallthrough: entry.allowImplicitEntryFallthrough
      });

      placements.set(entry.block, placement);
      rootPlacements.push(placement);
      for (const site of placement.analysis.invocations()) {
        if (placement.analysis.invocationMustExecute(site)) {
          const references = site.invocation.target.references;

          liveCalls.push(...references.functions);
          liveIndirectTypes.push(...references.types);
          liveTables.push(...references.tables);
        }
      }
    }
    const callTargets = unique([...fn.callTargets, ...liveCalls]);

    return {
      ...fn,
      calls: unique([...fn.calls, ...callTargets.map((call) => call.ref)]),
      callTargets,
      indirectTypes: unique(liveIndirectTypes),
      tables: unique(liveTables)
    };
  });

  return { functions, rootPlacements };
}

function linkDefinedFunctions(
  closure: FunctionClosure,
  placements: Map<IrBlock, BodyPlacement>
): readonly DefinedFunction[] {
  return [...closure.functions].map(([definition, closed]): DefinedFunction => {
    const { body, placement } = closed;
    const invocations = liveInvocations(placement.analysis);
    const directTargets: FunctionDefinition[] = [];
    const indirectTypes: FunctionType[] = [];
    const tables: TableRef[] = [];

    for (const invocation of invocations) {
      const references = invocation.target.references;

      directTargets.push(...references.functions);
      indirectTypes.push(...references.types);
      tables.push(...references.tables);
    }
    const resources = resourcesUsedBy(placement.analysis);

    placements.set(body, placement);
    return {
      kind: "function",
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
  definedFunctions: readonly DefinedFunction[],
  legacyFunctions: readonly LegacyFunction[],
  signatures: readonly Signature[]
): readonly FunctionType[] {
  const usedSignatures = new Set(legacyFunctions.map((fn) => fn.signature));

  for (const fn of legacyFunctions) {
    assert(
      signatures.some((signature) => signature.ref === fn.signature),
      `unknown program signature ${fn.signature.id} declared by function ${fn.ref.id}`
    );
  }

  return unique([
    ...definedFunctions.map((fn) => fn.type),
    ...legacyFunctions.flatMap((fn) => fn.indirectTypes),
    ...definedFunctions.flatMap((fn) => fn.indirectTypes),
    ...signatures
      .filter((signature) => usedSignatures.has(signature.ref))
      .map((signature) => signature.type)
  ]);
}

function collectFunctionDeclarations(
  options: LinkProgramOptions,
  legacyFunctions: readonly LegacyFunction[]
): Declarations<FunctionDeclaration> {
  const declarations = new Declarations<FunctionDeclaration>();

  for (const declaration of options.functions) {
    if (isFunctionDefinition(declaration)) {
      declareFunction(options, declarations, declaration);
    } else {
      declarations.add(declaration);
    }
  }
  for (const fn of legacyFunctions) {
    for (const target of fn.callTargets) {
      declareFunction(options, declarations, target);
    }
  }
  return declarations;
}

function declareFunction(
  options: LinkProgramOptions,
  declarations: Declarations<FunctionDeclaration>,
  definition: FunctionDefinition
): void {
  if (buildDefinition.validation) {
    validateProgramFunctionDeclaration(
      options,
      declarations.all(),
      definition
    );
  }
  const existing = declarations.get(definition.ref);

  if (existing === definition) {
    return;
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

function isLegacyFunction(declaration: FunctionDeclaration): declaration is LegacyFunction {
  return !isFunctionDefinition(declaration);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}
