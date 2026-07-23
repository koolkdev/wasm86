import { assert } from "#common/assert.js";
import type { FunctionAnalysis } from "#compiler/analysis/model.js";
import type {
  StorageAccess,
  StorageEffects
} from "#compiler/ir/effects.js";
import { describeNode } from "#compiler/ir/node.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import { covers } from "#compiler/ir/effects.js";
import { validateDeclaredStorageEffects } from "#compiler/ir/validate/effects.js";
import type { FunctionType } from "#compiler/ir/function.js";
import { FunctionDefinition } from "#compiler/program/functions.js";
import { maximumWasmTableElements } from "./limits.js";
import { FunctionImport } from "./imports.js";
import type { FunctionExport } from "./exports.js";
import type {
  FunctionDeclaration,
  Program,
  ProgramDeclarations,
  ProgramFunction
} from "./program.js";
import type { FunctionRef, TableRef } from "#compiler/ir/refs.js";

type Declaration = Readonly<{
  ref: Readonly<{ kind: string; id: string }>;
}>;

export function validateProgramDeclarations(
  declarations: ProgramDeclarations
): void {
  validateDeclarations(declarations.tables);
  validateDeclarations(declarations.functions);
  validateDeclarations(declarations.exports);
  validateTableLimits(declarations.tables);
  validateExportNames(declarations.exports);
  validateExternalImportNames(
    declarations.resources.memoryImports,
    declarations.functions.filter(isFunctionImport),
    declarations.tables
  );

  const functionsByRef = new Map(
    declarations.functions.map((fn) => [fn.ref, fn])
  );

  for (const fn of declarations.functions) {
    if (fn instanceof FunctionDefinition) {
      validateFunctionDefinitionDeclaration(declarations, fn);
    } else {
      validateFunctionImportDeclaration(declarations, fn);
    }
  }

  for (const exported of declarations.exports) {
    const target = functionsByRef.get(exported.target);

    assert(
      target instanceof FunctionDefinition,
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
  }
}

function validateTableLimits(
  tables: ProgramDeclarations["tables"]
): void {
  for (const table of tables) {
    assert(
      Number.isInteger(table.limits.minElements) &&
        table.limits.minElements >= 0 &&
        table.limits.minElements <= maximumWasmTableElements,
      `table ${table.ref.id} minimum elements out of range: ${table.limits.minElements}`
    );
    if (table.limits.maxElements !== undefined) {
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
  }
}

export function validateProgramFunctionDeclaration(
  declarations: ProgramDeclarations,
  knownFunctions: readonly FunctionDeclaration[],
  definition: FunctionDefinition
): void {
  const existing = knownFunctions.find((fn) => fn.ref === definition.ref);

  assert(
    existing === undefined || existing === definition,
    `duplicate program function declaration: ${definition.ref.id}`
  );
  assert(
    !knownFunctions.some(
      (fn) => fn !== definition && fn.ref.id === definition.ref.id
    ),
    `duplicate program function identity: ${definition.ref.id}`
  );
  validateFunctionDefinitionDeclaration(declarations, definition);
}

function validateFunctionDefinitionDeclaration(
  declarations: ProgramDeclarations,
  definition: FunctionDefinition
): void {
  assert(
    definition.isAvailableTo(declarations.owner),
    `function ${definition.ref.id} belongs to another program`
  );
  validateFunctionType(definition.type);
  validateDeclaredStorageEffects(
    definition.effects,
    `function ${definition.ref.id} declared`
  );
  for (const access of [...definition.effects.reads, ...definition.effects.writes]) {
    validateFunctionResourceEffect(declarations, definition.ref.id, access);
  }
}

function validateFunctionImportDeclaration(
  declarations: ProgramDeclarations,
  imported: FunctionImport
): void {
  assert(
    imported.isAvailableTo(declarations.owner),
    `function ${imported.ref.id} belongs to another program`
  );
  validateFunctionType(imported.type);
  validateDeclaredStorageEffects(
    imported.effects,
    `function import ${imported.ref.id} declared`
  );
  for (const access of [...imported.effects.reads, ...imported.effects.writes]) {
    validateFunctionResourceEffect(declarations, imported.ref.id, access);
  }
}

function validateFunctionResourceEffect(
  declarations: ProgramDeclarations,
  functionId: string,
  access: StorageAccess
): void {
  if (access.space === "resource") {
    assert(
      declarations.resources.memoryImports.some(
        (memory) => memory.ref === access.resource
      ),
      `unknown program resource ${access.resource.id} declared by function ${functionId}`
    );
  }
}

export function validateLinkedProgram(program: Program): void {
  const memories = new Set<ResourceRef>(
    program.memoryImports.map((memory) => memory.ref)
  );
  const tables = new Set(program.tables.map((table) => table.ref));
  const functions = new Map(program.functions.map((fn) => [fn.ref, fn]));
  const callTargets = new Map<
    FunctionRef,
    ProgramFunction | FunctionImport
  >([
    ...program.functionImports.map((imported) => [imported.ref, imported] as const),
    ...program.functions.map((fn) => [fn.ref, fn] as const)
  ]);

  validateProgramFunctionTypes(program);

  for (const fn of program.functions) {
    assert(
      fn.body.type === fn.type,
      `function ${fn.ref.id} body does not match its declared type`
    );
    validateKnownDirectTargets(fn, callTargets);
    for (const resource of fn.resources) {
      assert(
        memories.has(resource),
        `unknown program resource ${resource.id} used by function ${fn.ref.id}`
      );
    }
    for (const table of fn.tables) {
      assert(
        tables.has(table),
        `unknown program table ${table.id} used by function ${fn.ref.id}`
      );
    }
  }

  for (const exported of program.exports) {
    const target = functions.get(exported.target);

    assert(
      target !== undefined,
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
  }

  validateRequiredFunctionImports(program);
  for (const fn of program.functions) {
    validateProgramFunction(fn);
  }
}

function validateProgramFunctionTypes(program: Program): void {
  const functionTypes = new Set(program.functionTypes);

  assert(
    functionTypes.size === program.functionTypes.length,
    "program contains a duplicate function type"
  );

  const requiredTypes: FunctionType[] = [];

  for (const fn of program.functions) {
    assert(
      functionTypes.has(fn.type),
      `function ${fn.ref.id} type is missing from the program function types`
    );
    if (!requiredTypes.includes(fn.type)) {
      requiredTypes.push(fn.type);
    }
  }
  for (const imported of program.functionImports) {
    assert(
      functionTypes.has(imported.type),
      `function import ${imported.ref.id} type is missing from the program function types`
    );
    if (!requiredTypes.includes(imported.type)) {
      requiredTypes.push(imported.type);
    }
  }
  for (const fn of program.functions) {
    for (const type of fn.indirectTypes) {
      assert(
        functionTypes.has(type),
        `function ${fn.ref.id} live indirect type is missing from the program function types`
      );
      if (!requiredTypes.includes(type)) {
        requiredTypes.push(type);
      }
    }
  }

  const requiredTypeSet = new Set(requiredTypes);

  for (const type of program.functionTypes) {
    assert(
      requiredTypeSet.has(type),
      "program contains an unrequired function type"
    );
  }
  assert(
    sameIdentitySequence(program.functionTypes, requiredTypes),
    "program function types are not in required order"
  );
}

function validateDeclarations(declarations: readonly Declaration[]): void {
  const refs = new Set<object>();
  const ids = new Set<string>();

  for (const { ref } of declarations) {
    assert(
      !refs.has(ref),
      `duplicate program ${ref.kind} declaration: ${ref.id}`
    );
    refs.add(ref);
    assert(
      !ids.has(ref.id),
      `duplicate program ${ref.kind} identity: ${ref.id}`
    );
    ids.add(ref.id);
  }
}

type ExternalImportDeclaration = Readonly<{
  ref: Readonly<{ id: string }>;
  moduleName: string;
  name: string;
}>;

function validateExternalImportNames(
  memories: readonly ExternalImportDeclaration[],
  functions: readonly ExternalImportDeclaration[],
  tables: readonly ExternalImportDeclaration[]
): void {
  const namesByModule = new Map<string, Set<string>>();

  for (const imported of [...functions, ...memories, ...tables]) {
    assert(
      imported.moduleName.length > 0,
      `program import ${imported.ref.id} has an empty external module name`
    );
    assert(
      imported.name.length > 0,
      `program import ${imported.ref.id} has an empty external field name`
    );
    let names = namesByModule.get(imported.moduleName);

    if (names === undefined) {
      names = new Set();
      namesByModule.set(imported.moduleName, names);
    }
    assert(
      !names.has(imported.name),
      `duplicate program import external identity: ${imported.moduleName}.${imported.name}`
    );
    names.add(imported.name);
  }
}

function validateExportNames(exports: readonly FunctionExport[]): void {
  const names = new Set<string>();

  for (const exported of exports) {
    assert(exported.name.length > 0, "empty program function export name");
    assert(
      !names.has(exported.name),
      `duplicate program export name: ${exported.name}`
    );
    names.add(exported.name);
  }
}

function validateFunctionType(type: Readonly<{
  parameters: readonly ValueType[];
  results: readonly ValueType[];
}>): void {
  assert(
    type !== undefined && type !== null && typeof type === "object",
    "function type must be an object"
  );
  assert(
    Array.isArray(type.parameters) && Array.isArray(type.results),
    "function type must contain parameter and result arrays"
  );
  for (const valueType of [...type.parameters, ...type.results]) {
    assert(
      valueType === "i32" || valueType === "i64",
      `unknown function value type: ${String(valueType)}`
    );
  }
}

function validateKnownDirectTargets(
  fn: ProgramFunction,
  functions: ReadonlyMap<FunctionRef, ProgramFunction | FunctionImport>
): void {
  for (const ref of fn.directFunctions) {
    const linked = functions.get(ref);

    assert(
      linked !== undefined,
      `unknown program function ${ref.id} called by function ${fn.ref.id}`
    );
  }
}

function validateRequiredFunctionImports(program: Program): void {
  const required = new Set<FunctionImport>();
  const imports = new Map(
    program.functionImports.map((imported) => [imported.ref, imported])
  );

  for (const fn of program.functions) {
    for (const ref of fn.directFunctions) {
      const imported = imports.get(ref);

      if (imported !== undefined) {
        required.add(imported);
      }
    }
  }
  for (const imported of program.functionImports) {
    assert(
      required.has(imported),
      `program contains an unrequired function import ${imported.ref.id}`
    );
  }
  assert(
    required.size === program.functionImports.length,
    "program omitted a required function import"
  );
}

function validateProgramFunction(fn: ProgramFunction): void {
  const { placement } = fn;

  assert(
    placement.function === fn.body,
    "function placement belongs to another body"
  );

  const invocations = placement.analysis.invocations()
    .filter((site) => placement.analysis.invocationMustExecute(site))
    .map((site) => site.invocation);
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

  assert(
    sameIdentitySequence(fn.directFunctions, unique(directFunctions)),
    `function ${fn.ref.id} direct functions do not match its live invocations`
  );
  assert(
    sameIdentitySequence(fn.indirectTypes, unique(indirectTypes)),
    `function ${fn.ref.id} indirect types do not match its live invocations`
  );
  assert(
    sameIdentitySequence(fn.tables, unique(tables)),
    `function ${fn.ref.id} tables do not match its live invocations`
  );
  assert(
    sameIdentitySequence(fn.resources, resources),
    `function ${fn.ref.id} resources do not match its live operations`
  );
  validateDeclaredEffects(fn, placement.analysis);
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

function validateDeclaredEffects(
  fn: ProgramFunction,
  analysis: FunctionAnalysis
): void {
  const actual = inferEffects(analysis);

  assertEffectsCovered(fn, "read", actual.reads, fn.effects.reads);
  assertEffectsCovered(fn, "write", actual.writes, fn.effects.writes);
}

function inferEffects(analysis: FunctionAnalysis): StorageEffects {
  const reads = new Set<StorageAccess>();
  const writes = new Set<StorageAccess>();

  for (const site of analysis.sites()) {
    if (site.kind === "regionEnd") {
      continue;
    }
    const node = site.node;

    if (
      node.category === "operation" &&
      !analysis.operationMustExecute(node)
    ) {
      continue;
    }
    const { effects } = describeNode(node);

    addExternalEffects(effects.reads, reads);
    addExternalEffects(effects.writes, writes);
  }
  return { reads: [...reads], writes: [...writes] };
}

function addExternalEffects(
  effects: readonly StorageAccess[],
  target: Set<StorageAccess>
): void {
  for (const effect of effects) {
    if (effect.space !== "variable") {
      target.add(effect);
    }
  }
}

function assertEffectsCovered(
  fn: ProgramFunction,
  kind: "read" | "write",
  actual: readonly StorageAccess[],
  declared: readonly StorageAccess[]
): void {
  for (const access of actual) {
    assert(
      declared.some((candidate) => covers(candidate, access)),
      `function ${fn.ref.id} has an undeclared ${kind} effect`
    );
  }
}

function sameIdentitySequence<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isFunctionImport(
  declaration: FunctionDeclaration
): declaration is FunctionImport {
  return declaration instanceof FunctionImport;
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}
