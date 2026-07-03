import { assert } from "#common/assert.js";
import type { Action, Finish, IrExit } from "./actions.js";
import type { Body } from "./block.js";
import { opAccess, type OpAccess } from "./ops.js";
import { valueChildren, type ValueId, type ValueTable } from "./values.js";

export function nestedBodies(action: Action): readonly Body[] {
  switch (action.kind) {
    case "if":
      return action.elseBody === undefined
        ? [action.thenBody]
        : [action.thenBody, action.elseBody];
    case "switch":
      return [...action.cases.map((switchCase) => switchCase.body), action.defaultBody];
    case "op":
    case "finish":
      return [];
  }
}

export function walkBodyActions(
  body: Body,
  visit: (action: Action) => void
): void {
  for (const action of body.actions) {
    visit(action);

    for (const nested of nestedBodies(action)) {
      walkBodyActions(nested, visit);
    }
  }
}

export function bodyContains(root: Body, target: Body): boolean {
  if (root === target) {
    return true;
  }

  for (const action of root.actions) {
    for (const nested of nestedBodies(action)) {
      if (bodyContains(nested, target)) {
        return true;
      }
    }
  }

  return false;
}

// The value ids one action consumes, in operand order.
export function actionOperands(action: Action): readonly ValueId[] {
  switch (action.kind) {
    case "op":
      return opAccess(action.op).valueInputs;
    case "if":
      return [action.condition];
    case "switch":
      return [action.selector];
    case "finish":
      return finishOperands(action.finish);
  }
}

export function finishOperands(finish: Finish): readonly ValueId[] {
  switch (finish.kind) {
    case "exit":
      return exitOperands(finish.exit);
    case "dispatch":
      return [];
  }
}

function exitOperands(exit: IrExit): readonly ValueId[] {
  switch (exit.class) {
    case "cpuException": {
      const exception = exit.exception;

      switch (exception.kind) {
        case "DE":
          return [];
        case "PF":
          return [exception.linearAddress];
      }
    }
    case "host":
      return exit.payload === undefined ? [] : [exit.payload];
  }
}

// An action's declared output: an op action's iff its op produces a value,
// a switch's always — the selected body's result.
export function actionOutput(action: Action, access?: OpAccess): ValueId | undefined {
  switch (action.kind) {
    case "op": {
      if ((access ?? opAccess(action.op)).valueOutput === undefined) {
        return undefined;
      }

      assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
      return action.output;
    }
    case "switch":
      return action.output;
    case "if":
    case "finish":
      return undefined;
  }
}

// The action outputs a body's own actions produce; values computed from
// them are body-internal and can only materialize inside the body.
export function bodyProducedOutputs(body: Body): ReadonlySet<ValueId> {
  const produced = new Set<ValueId>();

  for (const action of body.actions) {
    const output = actionOutput(action);

    if (output !== undefined) {
      produced.add(output);
    }
  }

  return produced;
}

// True when the value is, or is computed from, any of the given ids.
export function valueDependsOn(
  values: ValueTable,
  id: ValueId,
  roots: ReadonlySet<ValueId>
): boolean {
  if (roots.size === 0) {
    return false;
  }

  const visited = new Set<ValueId>();
  const walk = (current: ValueId): boolean => {
    if (roots.has(current)) {
      return true;
    }

    if (visited.has(current)) {
      return false;
    }

    visited.add(current);
    return valueChildren(values.node(current)).some(walk);
  };

  return walk(id);
}

// Everything a nested body consumes from its parent context, its result
// included. The walk stops at values transitively produced inside the body;
// a body-internal compound decomposes into its parent-context children.
export function bodyInputValues(body: Body, values: ValueTable): readonly ValueId[] {
  const produced = bodyProducedOutputs(body);
  const inputs: ValueId[] = [];
  const decomposed = new Set<ValueId>();

  const collect = (id: ValueId): void => {
    if (produced.has(id)) {
      return;
    }

    if (!valueDependsOn(values, id, produced)) {
      inputs.push(id);
      return;
    }

    if (decomposed.has(id)) {
      return;
    }

    decomposed.add(id);
    for (const child of valueChildren(values.node(id))) {
      collect(child);
    }
  };

  for (const action of body.actions) {
    for (const operand of actionOperands(action)) {
      collect(operand);
    }

    for (const nested of nestedBodies(action)) {
      for (const input of bodyInputValues(nested, values)) {
        collect(input);
      }
    }
  }

  if (body.result !== undefined) {
    collect(body.result);
  }

  return inputs;
}
