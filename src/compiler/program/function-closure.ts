import { assert } from "#common/assert.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import { placeFunction, type BodyPlacement } from "#compiler/placement/place.js";
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
    for (const { call } of analysis.calls()) {
      const target = call.target;

      assertOwned(target);
      if (analysis.callMustExecute(call)) {
        enqueue(target);
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

    functions.set(definition, { body, placement });
    inspectCalls(placement.analysis);
  }

  return { functions };
}
