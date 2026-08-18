import { assert } from "#common/assert.js";
import { buildDefinition } from "#build";
import type { FunctionExport } from "#compiler/program/exports.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { FunctionImport } from "#compiler/program/imports.js";
import type { FunctionDeclaration, Program } from "#compiler/program/program.js";
import type { MemoryImport } from "#compiler/program/resources.js";
import { validateDeclaredFunctionEffects } from "#compiler/program/validate.js";
import type { FunctionRef, ResourceRef } from "#compiler/reference.js";
import { lowerWasmFunction } from "#compiler/wasm/lower/function.js";
import type { WasmFunctionPlan } from "#compiler/wasm/plan/function.js";
import { planWasmFunction } from "#compiler/wasm/plan/function.js";
import { toWasmFunctionType } from "#compiler/wasm/type-mapping.js";
import type { WasmFunctionType } from "#wasm/types.js";
import { validateWasmFunctionEffectCoverage } from "./validate.js";

export type PlannedWasmFunctionImport = Readonly<{
  ref: FunctionRef;
  type: WasmFunctionType;
  moduleName: string;
  name: string;
}>;

export type PlannedWasmFunction = Readonly<{
  ref: FunctionRef;
  type: WasmFunctionType;
  plan: WasmFunctionPlan;
}>;

export type WasmModulePlan = Readonly<{
  memoryImports: readonly MemoryImport[];
  functionImports: readonly PlannedWasmFunctionImport[];
  functions: readonly PlannedWasmFunction[];
  exports: readonly FunctionExport[];
}>;

type WasmModuleReachability = Readonly<{
  functions: ReadonlyMap<FunctionDefinition, PlannedWasmFunction>;
  functionImports: ReadonlySet<FunctionImport>;
  resources: ReadonlySet<ResourceRef>;
}>;

export function planWasmModule(program: Program): WasmModulePlan {
  const declaredImports = program.functions.filter(isFunctionImport);
  const roots = program.functions.filter(isFunctionDefinition);
  const declarations = new FunctionDeclarations(program.functions);
  const reachable = collectReachableFunctions(program, declarations, roots);

  return {
    memoryImports: program.resources.memoryImports.filter((memory) =>
      reachable.resources.has(memory.ref)
    ),
    functionImports: declaredImports
      .filter((imported) => reachable.functionImports.has(imported))
      .map(projectFunctionImport),
    functions: [...reachable.functions.values()],
    exports: program.exports
  };
}

function collectReachableFunctions(
  program: Program,
  declarations: FunctionDeclarations,
  roots: readonly FunctionDefinition[]
): WasmModuleReachability {
  const functions = new Map<FunctionDefinition, PlannedWasmFunction>();
  const liveImports = new Set<FunctionImport>();
  const liveResources = new Set<ResourceRef>();
  const resources = new Set(program.resources.memoryImports.map((memory) => memory.ref));
  const scheduled = new Set<FunctionDefinition>();
  const pending: FunctionDefinition[] = [];
  let next = 0;

  const assertOwned = (target: FunctionDeclaration): void => {
    assert(
      target.isAvailableTo(program.owner),
      `function ${target.ref.id} belongs to another program`
    );
  };
  const enqueue = (definition: FunctionDefinition): void => {
    assertOwned(definition);
    if (scheduled.has(definition)) {
      return;
    }
    declareFunction(program, declarations, definition);
    scheduled.add(definition);
    pending.push(definition);
  };
  const retainImport = (imported: FunctionImport): void => {
    assertOwned(imported);
    assert(
      declarations.get(imported.ref) === imported,
      `unknown program function import ${imported.ref.id}`
    );
    liveImports.add(imported);
  };

  for (const definition of roots) {
    enqueue(definition);
  }
  while (next < pending.length) {
    const definition = pending[next];

    next += 1;
    assert(definition !== undefined, "missing scheduled function");
    const planned = planDefinition(definition);

    for (const resource of planned.plan.dependencies.resources) {
      assert(
        resources.has(resource),
        `unknown program resource ${resource.id} used by function ${definition.ref.id}`
      );
      liveResources.add(resource);
    }
    for (const target of planned.plan.dependencies.directCalls) {
      assert(
        target instanceof FunctionImport || target instanceof FunctionDefinition,
        `unknown direct function target ${target.ref.id}`
      );
      if (target instanceof FunctionImport) {
        retainImport(target);
      } else {
        enqueue(target);
      }
    }
    if (buildDefinition.validation) {
      validateWasmFunctionEffectCoverage(definition, planned.plan);
    }
    functions.set(definition, planned);
  }

  return { functions, functionImports: liveImports, resources: liveResources };
}

function declareFunction(
  program: Program,
  declarations: FunctionDeclarations,
  definition: FunctionDefinition
): void {
  const existing = declarations.get(definition.ref);

  if (existing === definition) {
    return;
  }
  if (buildDefinition.validation) {
    validateDeclaredFunctionEffects(program.resources, definition);
  }
  declarations.add(definition);
}

function projectFunctionImport(imported: FunctionImport): PlannedWasmFunctionImport {
  return {
    ref: imported.ref,
    type: toWasmFunctionType(imported.type),
    moduleName: imported.moduleName,
    name: imported.name
  };
}

type PlannedFunctionArtifact = Readonly<{
  type: WasmFunctionType;
  plan: WasmFunctionPlan;
}>;

const plannedArtifacts = new WeakMap<FunctionDefinition, PlannedFunctionArtifact>();

function planDefinition(definition: FunctionDefinition): PlannedWasmFunction {
  const stable = definition.buildStability === "stable";
  const cached = stable ? plannedArtifacts.get(definition) : undefined;
  const artifact = cached ?? planFunctionArtifact(definition);

  if (stable && cached === undefined) {
    plannedArtifacts.set(definition, artifact);
  }
  return {
    ref: definition.ref,
    type: artifact.type,
    plan: artifact.plan
  };
}

function planFunctionArtifact(definition: FunctionDefinition): PlannedFunctionArtifact {
  return {
    type: toWasmFunctionType(definition.type),
    plan: planWasmFunction(lowerWasmFunction(definition.build()))
  };
}

function isFunctionDefinition(declaration: FunctionDeclaration): declaration is FunctionDefinition {
  return declaration instanceof FunctionDefinition;
}

function isFunctionImport(declaration: FunctionDeclaration): declaration is FunctionImport {
  return declaration instanceof FunctionImport;
}

class FunctionDeclarations {
  readonly #byRef = new Map<FunctionRef, FunctionDeclaration>();
  readonly #byId = new Map<string, FunctionDeclaration>();

  constructor(declarations: readonly FunctionDeclaration[]) {
    for (const declaration of declarations) {
      this.add(declaration);
    }
  }

  add(declaration: FunctionDeclaration): void {
    const { ref } = declaration;

    assert(!this.#byRef.has(ref), `duplicate program function declaration: ${ref.id}`);
    assert(!this.#byId.has(ref.id), `duplicate program function identity: ${ref.id}`);
    this.#byRef.set(ref, declaration);
    this.#byId.set(ref.id, declaration);
  }

  get(ref: FunctionRef): FunctionDeclaration | undefined {
    return this.#byRef.get(ref);
  }
}
