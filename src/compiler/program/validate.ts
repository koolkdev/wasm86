import { assert } from "#common/assert.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type {
  StorageAccess,
  StorageEffects
} from "#compiler/ir/effects.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { ValueType } from "#compiler/ir/values/types.js";
import { covers } from "#ir/aliasing.js";
import type { IrBlock } from "#ir/block.js";
import { validateDeclaredStorageEffects } from "#ir/validate/effects.js";
import type { FunctionType } from "./function-type.js";
import { FunctionDefinition } from "./functions.js";
import type { LinkProgramOptions } from "./link.js";
import type {
  DefinedFunction,
  FunctionDeclaration,
  FunctionExport,
  LegacyFunction,
  Program,
  ProgramFunction
} from "./model.js";
import type {
  FunctionRef,
  GlobalRef,
  SignatureRef,
  TableRef
} from "./refs.js";

type Declaration = Readonly<{
  ref: Readonly<{ kind: string; id: string }>;
}>;

export function validateProgramDeclarations(
  declarations: LinkProgramOptions
): void {
  validateDeclarations(declarations.signatures);
  validateDeclarations(declarations.memories);
  validateDeclarations(declarations.tables);
  validateDeclarations(declarations.globals);
  validateDeclarations(declarations.exports);
  validateExportNames(declarations.exports);

  for (const signature of declarations.signatures) {
    validateFunctionType(signature.type);
  }

  const signatures = new Map(
    declarations.signatures.map((signature) => [signature.ref, signature])
  );
  const memories = new Set(declarations.memories.map((memory) => memory.ref));
  const tables = new Set(declarations.tables.map((table) => table.ref));
  const globals = new Set(declarations.globals.map((global) => global.ref));
  const functions = collectDeclaredFunctions(declarations.functions);

  validateDeclarations(functions);
  const functionsByRef = new Map(functions.map((fn) => [fn.ref, fn]));

  for (const fn of functions) {
    if (fn instanceof FunctionDefinition) {
      validateFunctionDefinitionDeclaration(declarations, fn);
      continue;
    }

    assert(
      fn.effects === "none" || fn.effects === "world",
      `unknown legacy function effects: ${String(fn.effects)}`
    );
    assert(
      signatures.has(fn.signature),
      `unknown program signature ${fn.signature.id} declared by function ${fn.ref.id}`
    );
    for (const call of fn.calls) {
      assert(
        functionsByRef.has(call),
        `unknown program function ${call.id} called by function ${fn.ref.id}`
      );
    }
    for (const resource of fn.resources) {
      assert(
        memories.has(resource),
        `unknown program resource ${resource.id} used by function ${fn.ref.id}`
      );
    }
    for (const global of fn.globals) {
      assert(
        globals.has(global),
        `unknown program global ${global.id} used by function ${fn.ref.id}`
      );
    }
    for (const table of fn.tables) {
      assert(
        tables.has(table),
        `unknown program table ${table.id} used by function ${fn.ref.id}`
      );
    }
  }

  for (const exported of declarations.exports) {
    assert(
      functionsByRef.has(exported.target),
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
  }
}

export function validateProgramFunctionDeclaration(
  declarations: LinkProgramOptions,
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

export function validateLinkedProgramFunctions(
  declarations: readonly FunctionDeclaration[],
  functions: readonly ProgramFunction[]
): void {
  assert(
    functions.length === declarations.length,
    "linked program omitted a declared function"
  );
  const declared = new Set(declarations.map((declaration) => declaration.ref));

  for (const fn of functions) {
    assert(
      declared.has(fn.ref),
      `linked undeclared program function ${fn.ref.id}`
    );
  }
}

function validateFunctionDefinitionDeclaration(
  declarations: LinkProgramOptions,
  definition: FunctionDefinition
): void {
  assert(
    definition.canBeUsedBy(declarations.owner),
    `function ${definition.ref.id} belongs to another program`
  );
  assert(
    declarations.signatures.some((signature) => signature.type === definition.type),
    `function ${definition.ref.id} has no program signature`
  );
  validateDeclaredStorageEffects(
    definition.effects,
    `function ${definition.ref.id} declared`
  );
  const memories = new Set(declarations.memories.map((memory) => memory.ref));

  for (const access of [...definition.effects.reads, ...definition.effects.writes]) {
    if (access.space === "resource") {
      assert(
        memories.has(access.resource),
        `unknown program resource ${access.resource.id} declared by function ${definition.ref.id}`
      );
    }
  }
}

export function validateProgram(program: Program): void {
  validateDeclarations(program.signatures);
  validateDeclarations(program.memories);
  validateDeclarations(program.tables);
  validateDeclarations(program.globals);
  validateDeclarations(program.functions);
  validateDeclarations(program.exports);
  validateExportNames(program.exports);

  for (const signature of program.signatures) {
    validateFunctionType(signature.type);
  }
  for (const fn of program.functions) {
    if (fn.kind === "legacy") {
      assert(
        fn.effects === "none" || fn.effects === "world",
        `unknown legacy function effects: ${String(fn.effects)}`
      );
      continue;
    }
    validateDeclaredStorageEffects(
      fn.effects,
      `function ${fn.ref.id} declared`
    );
  }

  const signatures = new Map(
    program.signatures.map((signature) => [signature.ref, signature])
  );
  const memories = new Set(program.memories.map((memory) => memory.ref));
  const tables = new Set(program.tables.map((table) => table.ref));
  const globals = new Set(program.globals.map((global) => global.ref));
  const functions = new Map(program.functions.map((fn) => [fn.ref, fn]));

  for (const fn of program.functions) {
    const signature = signatures.get(fn.signature);

    assert(
      signature !== undefined,
      `unknown program signature ${fn.signature.id} declared by function ${fn.ref.id}`
    );
    if (fn.kind === "function") {
      assert(
        fn.type === signature.type,
        `function ${fn.ref.id} does not match its program signature`
      );
      assert(
        fn.body.type === fn.type,
        `function ${fn.ref.id} body does not match its declared type`
      );
    }

    validateKnownCalls(fn, functions);
    for (const resource of fn.resources) {
      assert(
        memories.has(resource),
        `unknown program resource ${resource.id} used by function ${fn.ref.id}`
      );
    }

    if (fn.kind === "legacy") {
      for (const global of fn.globals) {
        assert(
          globals.has(global),
          `unknown program global ${global.id} used by function ${fn.ref.id}`
        );
      }
      for (const table of fn.tables) {
        assert(
          tables.has(table),
          `unknown program table ${table.id} used by function ${fn.ref.id}`
        );
      }
      continue;
    }

    for (const access of [...fn.effects.reads, ...fn.effects.writes]) {
      if (access.space !== "resource") {
        continue;
      }
      assert(
        memories.has(access.resource),
        `unknown program resource ${access.resource.id} declared by function ${fn.ref.id}`
      );
    }
  }

  for (const exported of program.exports) {
    assert(
      functions.has(exported.target),
      `unknown program function ${exported.target.id} exported by ${exported.ref.id}`
    );
  }

  const retainedBodies = new Set<IrBlock>();

  for (const fn of program.functions) {
    switch (fn.kind) {
      case "legacy":
        validateLegacyFunction(program, fn, retainedBodies);
        break;
      case "function":
        validateDefinedFunction(program, fn, retainedBodies);
        break;
    }
  }

  assert(
    program.placements.size === retainedBodies.size,
    "program placement map does not match its retained bodies"
  );
  for (const [block, placement] of program.placements) {
    assert(
      retainedBodies.has(block),
      "program placement map contains an unknown body"
    );
    assert(
      placement.block === block,
      "program placement is indexed by the wrong body"
    );
  }
}

function collectDeclaredFunctions(
  declarations: readonly FunctionDeclaration[]
): readonly FunctionDeclaration[] {
  const functions: FunctionDeclaration[] = [];
  const byRef = new Map<FunctionDeclaration["ref"], FunctionDeclaration>();
  const add = (fn: FunctionDeclaration): void => {
    const existing = byRef.get(fn.ref);

    if (existing === fn) {
      return;
    }
    assert(
      existing === undefined,
      `duplicate program function declaration: ${fn.ref.id}`
    );
    byRef.set(fn.ref, fn);
    functions.push(fn);
  };

  for (const declaration of declarations) {
    add(declaration);
  }
  for (const declaration of declarations) {
    if (declaration instanceof FunctionDefinition) {
      continue;
    }
    for (const target of declaration.callTargets) {
      add(target);
    }
  }
  return functions;
}

export function validateProgramEncoding(
  program: Program,
  bodies: readonly EncodedWasmFunctionBody[]
): void {
  validateProgram(program);
  assert(
    bodies.length === program.functions.length,
    "program encoding body count does not match its functions"
  );
  const indices = indexProgramEncoding(program);

  for (const [index, fn] of program.functions.entries()) {
    const body = bodies[index];

    assert(body !== undefined, `missing encoded body for function ${fn.ref.id}`);
    switch (fn.kind) {
      case "legacy":
        validateLegacyEncoding(fn, body, indices);
        break;
      case "function":
        validateDefinedEncoding(fn, body, indices);
        break;
    }
  }
}

type ProgramEncodingIndices = Readonly<{
  signatures: ReadonlyMap<SignatureRef, number>;
  functions: ReadonlyMap<FunctionRef, number>;
  resources: ReadonlyMap<ResourceRef, number>;
  globals: ReadonlyMap<GlobalRef, number>;
  tables: ReadonlyMap<TableRef, number>;
}>;

function indexProgramEncoding(program: Program): ProgramEncodingIndices {
  const types: FunctionType[] = [];
  const signatures = new Map<SignatureRef, number>();

  for (const signature of program.signatures) {
    let index = types.findIndex((type) => functionTypesEqual(type, signature.type));

    if (index === -1) {
      index = types.length;
      types.push(signature.type);
    }
    signatures.set(signature.ref, index);
  }

  return {
    signatures,
    functions: new Map(program.functions.map((fn, index) => [fn.ref, index])),
    resources: new Map(program.memories.map((memory, index) => [memory.ref, index])),
    globals: new Map(program.globals.map((global, index) => [global.ref, index])),
    tables: new Map(program.tables.map((table, index) => [table.ref, index]))
  };
}

function validateLegacyEncoding(
  fn: LegacyFunction,
  body: EncodedWasmFunctionBody,
  indices: ProgramEncodingIndices
): void {
  const typeIndex = indices.signatures.get(fn.signature);

  assert(typeIndex !== undefined, `missing layout for program signature ${fn.signature.id}`);
  const functions = new Map<FunctionRef, number>();

  for (const call of fn.calls) {
    const index = indices.functions.get(call);

    assert(index !== undefined, `missing layout for called program function ${call.id}`);
    functions.set(call, index);
  }
  const resources = new Map(
    fn.resources.map((resource) => {
      const index = indices.resources.get(resource);

      assert(index !== undefined, `missing layout for program resource ${resource.id}`);
      return [resource, index] as const;
    })
  );
  const globals = new Map(
    fn.globals.map((global) => {
      const index = indices.globals.get(global);

      assert(index !== undefined, `missing layout for program global ${global.id}`);
      return [global, index] as const;
    })
  );
  const tables = new Map(
    fn.tables.map((table) => {
      const index = indices.tables.get(table);

      assert(index !== undefined, `missing layout for program table ${table.id}`);
      return [table, index] as const;
    })
  );
  validateEncodingReferences(fn, body, {
    functions: functions.values(),
    types: [typeIndex],
    globals: globals.values(),
    tables: tables.values(),
    memories: resources.values()
  });
}

function validateDefinedEncoding(
  fn: DefinedFunction,
  body: EncodedWasmFunctionBody,
  indices: ProgramEncodingIndices
): void {
  const functions = new Map(
    fn.callTargets.map((target) => {
      const index = indices.functions.get(target.ref);

      assert(index !== undefined, `missing layout for called program function ${target.ref.id}`);
      return [target, index] as const;
    })
  );
  const resources = new Map(
    fn.resources.map((resource) => {
      const index = indices.resources.get(resource);

      assert(index !== undefined, `missing layout for program resource ${resource.id}`);
      return [resource, index] as const;
    })
  );
  validateEncodingReferences(fn, body, {
    functions: functions.values(),
    types: [],
    globals: [],
    tables: [],
    memories: resources.values()
  });
}

type DeclaredEncodingReferences = Readonly<{
  functions: Iterable<number>;
  types: Iterable<number>;
  globals: Iterable<number>;
  tables: Iterable<number>;
  memories: Iterable<number>;
}>;

function validateEncodingReferences(
  fn: ProgramFunction,
  body: EncodedWasmFunctionBody,
  declared: DeclaredEncodingReferences
): void {
  validateRecordedIndices(fn, "function", body.references.functionIndices, declared.functions);
  validateRecordedIndices(fn, "type", body.references.typeIndices, declared.types);
  validateRecordedIndices(fn, "global", body.references.globalIndices, declared.globals);
  validateRecordedIndices(fn, "table", body.references.tableIndices, declared.tables);
  validateRecordedIndices(fn, "memory", body.references.memoryIndices, declared.memories);
}

function functionTypesEqual(a: FunctionType, b: FunctionType): boolean {
  return valueTypesEqual(a.parameters, b.parameters) && valueTypesEqual(a.results, b.results);
}

function valueTypesEqual(a: readonly ValueType[], b: readonly ValueType[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
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

function validateKnownCalls(
  fn: ProgramFunction,
  functions: ReadonlyMap<ProgramFunction["ref"], ProgramFunction>
): void {
  const calls = fn.kind === "legacy"
    ? fn.calls
    : fn.callTargets.map((target) => target.ref);

  for (const call of calls) {
    assert(
      functions.has(call),
      `unknown program function ${call.id} called by function ${fn.ref.id}`
    );
  }
  for (const target of fn.callTargets) {
    const linked = functions.get(target.ref);

    assert(
      linked !== undefined,
      `unknown program function ${target.ref.id} called by function ${fn.ref.id}`
    );
    assert(
      linked.kind === "function" &&
        linked.type === target.type &&
        linked.effects === target.effects,
      `function ${target.ref.id} call target does not match its linked definition`
    );
    if (fn.kind === "legacy") {
      assert(
        fn.calls.includes(target.ref),
        `legacy function ${fn.ref.id} omitted call target ${target.ref.id}`
      );
    }
  }
}

function validateLegacyFunction(
  program: Program,
  fn: LegacyFunction,
  retainedBodies: Set<IrBlock>
): void {
  for (const entry of fn.irBlocks) {
    const placement = program.placements.get(entry.block);

    assert(
      placement !== undefined,
      `missing placement for legacy function ${fn.ref.id}`
    );
    assert(
      placement.block === entry.block,
      "program placement belongs to another body"
    );
    retainedBodies.add(entry.block);

    for (const { action } of placement.analysis.calls()) {
      if (!placement.analysis.callActionMustExecute(action)) {
        continue;
      }
      assert(
        fn.callTargets.includes(action.target) &&
          fn.calls.includes(action.target.ref),
        `legacy function ${fn.ref.id} omitted live call ${action.target.ref.id}`
      );
    }
    for (const resource of resourcesUsedBy(placement.analysis)) {
      assert(
        fn.resources.includes(resource),
        `undeclared program resource ${resource.id} used by legacy function ${fn.ref.id}`
      );
    }
  }
}

function validateDefinedFunction(
  program: Program,
  fn: DefinedFunction,
  retainedBodies: Set<IrBlock>
): void {
  const placement = program.placements.get(fn.body);

  assert(placement !== undefined, `missing placement for function ${fn.ref.id}`);
  assert(
    placement === fn.placement,
    `function ${fn.ref.id} does not retain its program placement`
  );
  assert(
    placement.block === fn.body,
    "program placement belongs to another body"
  );
  retainedBodies.add(fn.body);

  const callTargets = unique(
    placement.analysis.calls()
      .filter(({ action }) => placement.analysis.callActionMustExecute(action))
      .map(({ action }) => action.target)
  );
  const resources = resourcesUsedBy(placement.analysis);

  assert(
    sameIdentitySequence(fn.callTargets, callTargets),
    `function ${fn.ref.id} call targets do not match its live calls`
  );
  assert(
    sameIdentitySequence(fn.resources, resources),
    `function ${fn.ref.id} resources do not match its live operations`
  );
  validateDeclaredEffects(fn, placement.analysis);
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

function validateDeclaredEffects(
  fn: DefinedFunction,
  analysis: BodyAnalysis
): void {
  const actual = inferEffects(analysis);

  assertEffectsCovered(fn, "read", actual.reads, fn.effects.reads);
  assertEffectsCovered(fn, "write", actual.writes, fn.effects.writes);
}

function inferEffects(analysis: BodyAnalysis): StorageEffects {
  const reads = new Set<StorageAccess>();
  const writes = new Set<StorageAccess>();

  for (const { action } of analysis.operations()) {
    if (analysis.actionMustExecute(action)) {
      addExternalEffects(action.op.effects.reads, reads);
      addExternalEffects(action.op.effects.writes, writes);
    }
  }
  for (const { action } of analysis.calls()) {
    if (analysis.callActionMustExecute(action)) {
      addExternalEffects(action.target.effects.reads, reads);
      addExternalEffects(action.target.effects.writes, writes);
    }
  }
  return { reads: [...reads], writes: [...writes] };
}

function addExternalEffects(
  effects: readonly StorageAccess[],
  target: Set<StorageAccess>
): void {
  for (const effect of effects) {
    if (effect.space !== "cell") {
      target.add(effect);
    }
  }
}

function assertEffectsCovered(
  fn: DefinedFunction,
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

function validateRecordedIndices(
  fn: ProgramFunction,
  kind: "function" | "type" | "global" | "table" | "memory",
  recorded: readonly number[],
  declared: Iterable<number>
): void {
  const declaredIndices = new Set(declared);

  for (const index of recorded) {
    assert(
      declaredIndices.has(index),
      `${fn.kind} function ${fn.ref.id} used undeclared Wasm ${kind} index ${index}`
    );
  }
}

function sameIdentitySequence<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function unique<T>(values: readonly T[]): readonly T[] {
  return [...new Set(values)];
}
