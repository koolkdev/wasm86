import { assert } from "#common/assert.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type {
  StorageEffects,
  StorageAccess
} from "#compiler/ir/effects.js";
import { placeFunction, type BodyPlacement } from "#compiler/placement/place.js";
import { channelCovers, isDynamicSlot, type StateSlot } from "#ir/slots.js";
import { buildFunction, type IrFunction } from "#ir/function.js";
import type { FunctionDefinition } from "./functions.js";

export type ClosedFunction = Readonly<{
  body: IrFunction;
  placement: BodyPlacement;
}>;

export type FunctionClosure = Readonly<{
  functions: ReadonlyMap<FunctionDefinition, ClosedFunction>;
}>;

export type CloseFunctionsOptions = Readonly<{
  owner: object;
  roots: readonly FunctionDefinition[];
  declaredFunctions: readonly FunctionDefinition[];
  rootPlacements: readonly BodyPlacement[];
  declareFunction(definition: FunctionDefinition): void;
}>;

export function closeFunctions(options: CloseFunctionsOptions): FunctionClosure {
  const functions = new Map<FunctionDefinition, ClosedFunction>();
  const scheduled = new Set<FunctionDefinition>();
  const pending: FunctionDefinition[] = [];
  let next = 0;

  const assertOwned = (definition: FunctionDefinition): void => {
    assert(
      definition.canBeUsedBy(options.owner),
      `function ${definition.ref.id} belongs to another program`
    );
  };
  const enqueue = (definition: FunctionDefinition): void => {
    assertOwned(definition);
    if (!scheduled.has(definition)) {
      options.declareFunction(definition);
      scheduled.add(definition);
      pending.push(definition);
    }
  };
  const inspectCalls = (analysis: BodyAnalysis): void => {
    for (const { action } of analysis.calls()) {
      assertOwned(action.target);
      if (analysis.callActionMustExecute(action)) {
        enqueue(action.target);
      }
    }
  };

  for (const definition of [...options.roots, ...options.declaredFunctions]) {
    enqueue(definition);
  }
  for (const placement of options.rootPlacements) {
    inspectCalls(placement.analysis);
  }
  while (next < pending.length) {
    const definition = pending[next];

    next += 1;
    assert(definition !== undefined, "missing scheduled function");
    const body = buildFunction(definition.type, (fn) => definition.build(fn));
    const placement = placeFunction(body);

    validateDeclaredEffects(definition, placement.analysis);
    functions.set(definition, { body, placement });
    inspectCalls(placement.analysis);
  }

  return { functions };
}

function validateDeclaredEffects(
  definition: FunctionDefinition,
  analysis: BodyAnalysis
): void {
  const actual = inferEffects(analysis);

  assertEffectsCovered(definition, "read", actual.reads, definition.effects.reads);
  assertEffectsCovered(definition, "write", actual.writes, definition.effects.writes);
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
    if (!analysis.callActionMustExecute(action)) {
      continue;
    }
    const effects = action.target.effects;

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
    if (effect.space !== "cell") {
      target.add(effect);
    }
  }
}

function assertEffectsCovered(
  definition: FunctionDefinition,
  kind: "read" | "write",
  actual: readonly StorageAccess[],
  declared: readonly StorageAccess[]
): void {
  for (const access of actual) {
    assert(
      declared.some((candidate) => accessCovers(candidate, access)),
      `function ${definition.ref.id} has an undeclared ${kind} effect`
    );
  }
}

function accessCovers(declared: StorageAccess, actual: StorageAccess): boolean {
  switch (declared.space) {
    case "memory":
    case "memoryBounds":
      return actual.space === declared.space;
    case "cell":
      return actual.space === "cell" && actual.cell === declared.cell;
    case "state":
      return actual.space === "state" && stateSlotCovers(declared.slot, actual.slot);
  }
}

function stateSlotCovers(declared: StateSlot, actual: StateSlot): boolean {
  if (isDynamicSlot(declared)) {
    if (declared.kind === "gprDynamic") {
      return (actual.kind === "gpr" && declared.byteLength === actual.byteLength) ||
        (actual.kind === "gprDynamic" && declared.byteLength === actual.byteLength);
    }
    return (actual.kind === "segment" && declared.field === actual.field) ||
      (actual.kind === "segmentDynamic" && declared.field === actual.field);
  }
  return !isDynamicSlot(actual) && channelCovers(declared, actual);
}
