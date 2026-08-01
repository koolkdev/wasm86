import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { FunctionAnalysis } from "#compiler/wasm/legacy/analysis/model.js";
import { buildFunction } from "#compiler/ir/builder/function.js";
import type { IrFunction } from "#compiler/ir/function.js";
import type { Invocation } from "#compiler/ir/invocation.js";
import { describeNode } from "#compiler/ir/node.js";
import {
  placeFunction,
  type FunctionPlacement
} from "#compiler/wasm/legacy/placement/place.js";
import type { FunctionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { FunctionImport } from "./imports.js";
import type {
  FunctionDeclaration,
  Program,
  ProgramData,
  ProgramDeclarations,
  ProgramFunction
} from "./program.js";
import type { FunctionRef, TableRef } from "#compiler/reference.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { MemoryImport, ProgramResources } from "./resources.js";
import { validateDeclaredFunctionEffects, validateFunctionEffectCoverage } from "./validate.js";

type ReachableFunction = Readonly<{
  body: IrFunction;
  placement: FunctionPlacement;
}>;

type Ref = Readonly<{ kind: string; id: string }>;
type Declaration = Readonly<{ ref: Ref }>;

export class DeclarationCollection<T extends Declaration> {
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

  get(ref: T["ref"]): T | undefined {
    return this.#byRef.get(ref);
  }

  all(): readonly T[] {
    return [...this.#ordered];
  }
}

export function buildProgram(options: ProgramDeclarations): Program {
  const declaredImports = options.functions.filter(isFunctionImport);
  const roots = options.functions.filter(isFunctionDefinition);

  validateExportTargets(options, roots);
  const declarations = collectFunctionDeclarations(options);

  const liveImports = new Set<FunctionImport>();
  const reachable = collectReachableFunctions(options, declarations, liveImports, roots);
  const functionImports = declaredImports.filter((imported) => liveImports.has(imported));
  const functions = createProgramFunctions(reachable);
  const functionTypes = collectProgramFunctionTypes(functions, functionImports);
  const memoryImports = collectMemoryImports(options.resources, functions);

  if (buildDefinition.validation) {
    for (const fn of functions) {
      validateFunctionEffectCoverage(fn, fn.placement.analysis);
    }
  }
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
  return resources.memoryImports.filter((memory) => used.has(memory.ref));
}

function retainFunctionImport(
  options: ProgramDeclarations,
  declarations: DeclarationCollection<FunctionDeclaration>,
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

function createProgramFunctions(
  reachable: ReadonlyMap<FunctionDefinition, ReachableFunction>
): readonly ProgramFunction[] {
  return [...reachable].map(([definition, fn]): ProgramFunction => {
    const { body, placement } = fn;

    const invocations = liveInvocations(placement.analysis);
    const directFunctions: FunctionRef[] = [];
    const indirectTypes: FunctionType[] = [];
    const tables: TableRef[] = [];

    for (const invocation of invocations) {
      const { target } = invocation;

      if (target.kind === "direct") {
        directFunctions.push(target.ref);
      } else {
        indirectTypes.push(target.type);
        tables.push(target.table);
      }
    }
    const resources = resourcesUsedBy(placement.analysis);

    return {
      ref: definition.ref,
      type: definition.type,
      effects: definition.effects,
      directFunctions: unique(directFunctions),
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
  options: ProgramDeclarations
): DeclarationCollection<FunctionDeclaration> {
  const declarations = new DeclarationCollection<FunctionDeclaration>();

  for (const declaration of options.functions) {
    declarations.add(declaration);
  }
  return declarations;
}

function declareFunction(
  options: ProgramDeclarations,
  declarations: DeclarationCollection<FunctionDeclaration>,
  definition: FunctionDefinition
): void {
  const existing = declarations.get(definition.ref);

  if (existing === definition) {
    return;
  }
  if (buildDefinition.validation) {
    validateDeclaredFunctionEffects(options.resources, definition);
  }
  declarations.add(definition);
}

function collectReachableFunctions(
  options: ProgramDeclarations,
  declarations: DeclarationCollection<FunctionDeclaration>,
  liveImports: Set<FunctionImport>,
  roots: readonly FunctionDefinition[]
): ReadonlyMap<FunctionDefinition, ReachableFunction> {
  const functions = new Map<FunctionDefinition, ReachableFunction>();
  const tables = new Set(options.tables.map((table) => table.ref));
  const scheduled = new Set<FunctionDefinition>();
  const pending: FunctionDefinition[] = [];
  let next = 0;

  const assertOwned = (target: FunctionDeclaration): void => {
    assert(
      target.isAvailableTo(options.owner),
      `function ${target.ref.id} belongs to another program`
    );
  };
  const enqueue = (definition: FunctionDefinition): void => {
    assertOwned(definition);
    if (!scheduled.has(definition)) {
      declareFunction(options, declarations, definition);
      scheduled.add(definition);
      pending.push(definition);
    }
  };
  const inspectInvocations = (definition: FunctionDefinition, analysis: FunctionAnalysis): void => {
    for (const site of analysis.invocations()) {
      const mustExecute = analysis.invocationMustExecute(site);
      const { target } = site.invocation;

      if (target.kind !== "direct") {
        if (mustExecute) {
          assert(
            tables.has(target.table),
            `unknown program table ${target.table.id} used by function ${definition.ref.id}`
          );
        }
        continue;
      }
      assert(
        target instanceof FunctionImport || target instanceof FunctionDefinition,
        `unknown direct function target ${target.ref.id}`
      );
      assertOwned(target);
      if (mustExecute) {
        if (target instanceof FunctionImport) {
          retainFunctionImport(options, declarations, liveImports, target);
        } else {
          enqueue(target);
        }
      }
    }
  };

  for (const definition of roots) {
    enqueue(definition);
  }
  while (next < pending.length) {
    const definition = pending[next];

    next += 1;
    assert(definition !== undefined, "missing scheduled function");
    const body = buildFunction(definition.type, (fn) => definition.build(fn));
    const placement = placeFunction(body);

    functions.set(definition, { body, placement });
    inspectInvocations(definition, placement.analysis);
  }

  return functions;
}

function validateExportTargets(
  options: ProgramDeclarations,
  definitions: readonly FunctionDefinition[]
): void {
  const functions = new Set(definitions.map((definition) => definition.ref));

  for (const exported of options.exports) {
    assert(
      functions.has(exported.target),
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
  }
}

function resourcesUsedBy(analysis: FunctionAnalysis): readonly ResourceRef[] {
  const resources: ResourceRef[] = [];

  for (const { operation } of analysis.operations()) {
    if (!analysis.operationMustExecute(operation)) {
      continue;
    }
    resources.push(...describeNode(operation).referencedResources);
  }
  return unique(resources);
}

function liveInvocations(analysis: FunctionAnalysis): readonly Invocation[] {
  return analysis
    .invocations()
    .filter((site) => analysis.invocationMustExecute(site))
    .map((site) => site.invocation);
}

function isFunctionDefinition(declaration: FunctionDeclaration): declaration is FunctionDefinition {
  return declaration instanceof FunctionDefinition;
}

function isFunctionImport(declaration: FunctionDeclaration): declaration is FunctionImport {
  return declaration instanceof FunctionImport;
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}
