import type { Action } from "./actions.js";
import type { Body } from "./block.js";

export function nestedBodies(action: Action): readonly Body[] {
  switch (action.kind) {
    case "guardMemory":
      return [action.faultBody];
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
