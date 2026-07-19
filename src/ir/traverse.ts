import { assert } from "#common/assert.js";
import type { Action, Finish } from "./actions.js";
import type { Body } from "./block.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";

export function nestedBodies(action: Action): readonly Body[] {
  switch (action.kind) {
    case "if":
      return action.elseBody === undefined
        ? [action.thenBody]
        : [action.thenBody, action.elseBody];
    case "switch":
      return [...action.cases.map((switchCase) => switchCase.body), action.defaultBody];
    case "loop":
      return [action.body];
    case "op":
    case "call":
    case "returnCall":
    case "loopContinue":
    case "finish":
    case "return":
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

// The value ids one action consumes, in operand order. A loop consumes its
// seeds at entry; a loopContinue consumes its updates at the back edge.
export function actionOperands(action: Action): readonly ValueId[] {
  switch (action.kind) {
    case "op":
      return action.op.inputs.map((input) => input.value);
    case "call":
      return action.arguments.map((argument) => argument.value);
    case "returnCall":
      return action.arguments.map((argument) => argument.value);
    case "if":
      return [action.condition];
    case "switch":
      return [action.selector];
    case "loop":
      return action.carried.map((cell) => cell.seed);
    case "loopContinue":
      return action.updates;
    case "finish":
      return finishOperands(action.finish);
    case "return":
      return action.results;
  }
}

export function finishOperands(finish: Finish): readonly ValueId[] {
  switch (finish.kind) {
    case "exit":
      return [finish.result];
    case "dispatch":
      return [finish.targetEip];
  }
}

// An action's declared output: an op action's iff its op produces a value,
// and value-producing control owns the selected body's result.
export function actionOutput(action: Action): ValueId | undefined {
  switch (action.kind) {
    case "op": {
      if (action.op.result === undefined) {
        return undefined;
      }

      assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
      return action.output;
    }
    case "call": {
      assert(action.outputs.length <= 1, "multiple call outputs are not supported yet");
      return action.outputs[0];
    }
    case "if":
      return action.output;
    case "switch":
      return action.output;
    case "loop":
    case "loopContinue":
    case "finish":
    case "return":
    case "returnCall":
      return undefined;
  }
}

export function actionOutputs(action: Action): readonly ValueId[] {
  const output = actionOutput(action);

  return output === undefined ? [] : [output];
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
    return values.children(current).some(walk);
  };

  return walk(id);
}

// Everything a nested body consumes from its parent context, its result
// included. The walk stops at values transitively produced inside the body —
// a loop body's own input leaves included, so loop-input-dependent values
// are never treated as parent-context inputs; a body-internal compound
// decomposes into its parent-context children.
export function bodyInputValues(
  body: Body,
  values: ValueTable,
  extraProduced: Iterable<ValueId> = []
): readonly ValueId[] {
  const produced = new Set([...bodyProducedOutputs(body), ...extraProduced]);
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
    for (const child of values.children(id)) {
      collect(child);
    }
  };

  for (const action of body.actions) {
    for (const operand of actionOperands(action)) {
      collect(operand);
    }

    for (const nested of nestedBodies(action)) {
      for (const input of bodyInputValues(nested, values, loopInputsOf(action))) {
        collect(input);
      }
    }
  }

  if (body.result !== undefined) {
    collect(body.result);
  }

  return inputs;
}

export function loopInputsOf(action: Action): readonly ValueId[] {
  return action.kind === "loop" ? action.carried.map((cell) => cell.loopInput) : [];
}
