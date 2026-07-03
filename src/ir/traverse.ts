import { assert } from "#common/assert.js";
import type { Action, Finish, IrExit } from "./actions.js";
import type { Body } from "./block.js";
import { opAccess, type OpAccess } from "./ops.js";
import type { ValueId } from "./values.js";

export function nestedBodies(action: Action): readonly Body[] {
  switch (action.kind) {
    case "if":
      return action.elseBody === undefined
        ? [action.thenBody]
        : [action.thenBody, action.elseBody];
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

// An op action's declared output, present iff its op produces a value.
export function actionOutput(action: Action, access?: OpAccess): ValueId | undefined {
  switch (action.kind) {
    case "op": {
      if ((access ?? opAccess(action.op)).valueOutput === undefined) {
        return undefined;
      }

      assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
      return action.output;
    }
    case "if":
    case "finish":
      return undefined;
  }
}

// Everything a nested body consumes from its parent context. Values produced
// inside the body are deliberately excluded; their consumers run after the
// producer action has executed.
export function bodyInputValues(body: Body): readonly ValueId[] {
  const produced = new Set<ValueId>();
  const values: ValueId[] = [];

  for (const action of body.actions) {
    for (const operand of actionOperands(action)) {
      if (!produced.has(operand)) {
        values.push(operand);
      }
    }

    for (const nested of nestedBodies(action)) {
      for (const operand of bodyInputValues(nested)) {
        if (!produced.has(operand)) {
          values.push(operand);
        }
      }
    }

    const output = actionOutput(action);

    if (output !== undefined) {
      produced.add(output);
    }
  }

  return values;
}
