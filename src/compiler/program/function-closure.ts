import { assert } from "#common/assert.js";
import type { BodyAnalysis } from "#compiler/analysis/model.js";
import type { DirectFunctionTarget } from "#compiler/ir/invocation.js";
import { placeFunction, type BodyPlacement } from "#compiler/placement/place.js";
import { buildFunction, type IrFunction } from "#ir/function.js";
import { FunctionDefinition } from "./functions.js";
import { FunctionImport } from "./imports.js";

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
  retainFunctionImport(imported: FunctionImport): void;
}>;

export function closeFunctions(options: CloseFunctionsOptions): FunctionClosure {
  const functions = new Map<FunctionDefinition, ClosedFunction>();
  const scheduled = new Set<FunctionDefinition>();
  const pending: FunctionDefinition[] = [];
  let next = 0;

  const assertOwned = (target: DirectFunctionTarget): void => {
    assert(
      target.isAvailableTo(options.owner),
      `function ${target.ref.id} belongs to another program`
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
  const inspectInvocations = (analysis: BodyAnalysis): void => {
    for (const site of analysis.invocations()) {
      const mustExecute = analysis.invocationMustExecute(site);

      for (const target of site.invocation.target.references.functions) {
        assertOwned(target);
        if (mustExecute) {
          if (target instanceof FunctionImport) {
            options.retainFunctionImport(target);
          } else {
            assert(
              target instanceof FunctionDefinition,
              `unknown direct function target ${target.ref.id}`
            );
            enqueue(target);
          }
        }
      }
    }
  };

  for (const definition of [...options.roots, ...options.declaredFunctions]) {
    enqueue(definition);
  }
  for (const placement of options.rootPlacements) {
    inspectInvocations(placement.analysis);
  }
  while (next < pending.length) {
    const definition = pending[next];

    next += 1;
    assert(definition !== undefined, "missing scheduled function");
    const body = buildFunction(definition.type, (fn) => definition.build(fn));
    const placement = placeFunction(body);

    functions.set(definition, { body, placement });
    inspectInvocations(placement.analysis);
  }

  return { functions };
}
