import { assert } from "#common/assert.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import { placeBody, type BodyPlacement } from "#compiler/placement/place.js";
import type { IrBlock } from "#ir/block.js";
import { Declarations } from "./declarations.js";
import { closeFunctions, type FunctionClosure } from "./function-closure.js";
import { FunctionDefinition } from "./functions.js";
import type {
  DefinedFunction,
  FunctionDeclaration,
  FunctionExport,
  InternalGlobal,
  LegacyFunction,
  MemoryImport,
  Program,
  ProgramData,
  ProgramFunction,
  Signature,
  TableImport
} from "./model.js";
import type { ResourceRef } from "#compiler/ir/resource.js";

export type LinkProgramOptions = Readonly<{
  owner: object;
  signatures: readonly Signature[];
  memories: readonly MemoryImport[];
  tables: readonly TableImport[];
  globals: readonly InternalGlobal[];
  functions: readonly FunctionDeclaration[];
  exports: readonly FunctionExport[];
}>;

export function linkProgram(options: LinkProgramOptions): Program {
  const declaredLegacy = options.functions.filter(isLegacyFunction);
  const roots = options.functions.filter(isFunctionDefinition);
  const declarations = collectFunctionDeclarations(options, declaredLegacy);

  validateStaticProgram(options, declaredLegacy, declarations);
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
  const defined = materializeDefinedFunctions(
    closure,
    options.signatures,
    placements
  );
  const functions: readonly ProgramFunction[] = [...legacy.functions, ...defined];

  validateLinkedFunctions(functions, declarations, options.memories);
  const program: ProgramData = {
    signatures: options.signatures,
    memories: options.memories,
    tables: options.tables,
    globals: options.globals,
    functions,
    exports: options.exports,
    placements
  };

  return program as Program;
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
    const liveResources: ResourceRef[] = [];

    for (const entry of fn.irBlocks) {
      const placement = placeBody(entry.block, {
        allowImplicitEntryFallthrough: entry.allowImplicitEntryFallthrough
      });

      placements.set(entry.block, placement);
      rootPlacements.push(placement);
      for (const { action } of placement.analysis.calls()) {
        if (placement.analysis.callActionMustExecute(action)) {
          liveCalls.push(action.target);
        }
      }
      liveResources.push(...resourcesUsedBy(placement.analysis));
    }
    const callTargets = unique([...fn.callTargets, ...liveCalls]);

    for (const resource of unique(liveResources)) {
      assert(
        fn.resources.includes(resource),
        `undeclared program resource ${resource.id} used by legacy function ${fn.ref.id}`
      );
    }

    return {
      ...fn,
      calls: unique([...fn.calls, ...callTargets.map((call) => call.ref)]),
      callTargets
    };
  });

  return { functions, rootPlacements };
}

function materializeDefinedFunctions(
  closure: FunctionClosure,
  signatures: readonly Signature[],
  placements: Map<IrBlock, BodyPlacement>
): readonly DefinedFunction[] {
  return [...closure.functions].map(([definition, closed]): DefinedFunction => {
    const { body, placement } = closed;
    const signature = signatures.find((candidate) => candidate.type === definition.type);

    assert(signature !== undefined, `function ${definition.ref.id} has no program signature`);
    const callTargets = unique(placement.analysis.calls()
      .filter(({ action }) => placement.analysis.callActionMustExecute(action))
      .map(({ action }) => action.target));
    const resources = resourcesUsedBy(placement.analysis);

    placements.set(body, placement);
    return {
      kind: "function",
      ref: definition.ref,
      type: definition.type,
      effects: definition.effects,
      signature: signature.ref,
      callTargets,
      resources,
      body,
      placement
    };
  });
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
  assert(
    definition.canBeUsedBy(options.owner),
    `function ${definition.ref.id} belongs to another program`
  );
  const existing = declarations.get(definition.ref);

  if (existing === definition) {
    return;
  }
  declarations.add(definition);
  assert(
    options.signatures.some((signature) => signature.type === definition.type),
    `function ${definition.ref.id} has no program signature`
  );
}

function validateStaticProgram(
  options: LinkProgramOptions,
  legacyFunctions: readonly LegacyFunction[],
  functions: Declarations<FunctionDeclaration>
): void {
  for (const fn of legacyFunctions) {
    const signature = declarationByRef(options.signatures, fn.signature);

    assert(
      signature !== undefined,
      `unknown program signature ${fn.signature.id} declared by function ${fn.ref.id}`
    );
    for (const call of fn.calls) {
      assert(
        functions.has(call),
        `unknown program function ${call.id} called by function ${fn.ref.id}`
      );
    }
    for (const resource of fn.resources) {
      assert(
        declarationByRef(options.memories, resource) !== undefined,
        `unknown program resource ${resource.id} used by function ${fn.ref.id}`
      );
    }
    for (const global of fn.globals) {
      assert(
        declarationByRef(options.globals, global) !== undefined,
        `unknown program global ${global.id} used by function ${fn.ref.id}`
      );
    }
    for (const table of fn.tables) {
      assert(
        declarationByRef(options.tables, table) !== undefined,
        `unknown program table ${table.id} used by function ${fn.ref.id}`
      );
    }
  }

  for (const exported of options.exports) {
    assert(
      functions.has(exported.target),
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
  }
}

function validateLinkedFunctions(
  functions: readonly ProgramFunction[],
  declarations: Declarations<FunctionDeclaration>,
  memories: readonly MemoryImport[]
): void {
  assert(
    functions.length === declarations.all().length,
    "linked program omitted a declared function"
  );
  for (const fn of functions) {
    assert(declarations.has(fn.ref), `linked undeclared program function ${fn.ref.id}`);
    const calls = fn.kind === "legacy"
      ? fn.calls
      : fn.callTargets.map((target) => target.ref);

    for (const call of calls) {
      assert(
        declarations.has(call),
        `unknown program function ${call.id} called by function ${fn.ref.id}`
      );
    }
    for (const resource of fn.resources) {
      assert(
        declarationByRef(memories, resource) !== undefined,
        `unknown program resource ${resource.id} used by function ${fn.ref.id}`
      );
    }
    if (fn.kind === "function") {
      for (const access of [...fn.effects.reads, ...fn.effects.writes]) {
        if (access.space !== "resource") {
          continue;
        }
        assert(
          declarationByRef(memories, access.resource) !== undefined,
          `unknown program resource ${access.resource.id} declared by function ${fn.ref.id}`
        );
      }
    }
  }
}

function resourcesUsedBy(analysis: BodyAnalysis): readonly ResourceRef[] {
  const resources: ResourceRef[] = [];

  for (const { action } of analysis.operations()) {
    if (!analysis.opActionMustExecute(action)) {
      continue;
    }
    for (const access of [
      ...action.op.effects.reads,
      ...action.op.effects.writes
    ]) {
      if (access.space === "resource") {
        resources.push(access.resource);
      }
    }
  }
  return unique(resources);
}

function declarationByRef<TDeclaration extends Readonly<{ ref: object }>>(
  declarations: readonly TDeclaration[],
  ref: TDeclaration["ref"]
): TDeclaration | undefined {
  return declarations.find((declaration) => declaration.ref === ref);
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
