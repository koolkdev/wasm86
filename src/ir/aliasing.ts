import { channelsOverlap, isDynamicSlot } from "./slots.js";
import type { Action } from "./actions.js";
import type { Body } from "./block.js";
import type {
  OperationEffects,
  StorageAccess
} from "#compiler/ir/operations/definition.js";
import type { StateSlot } from "./slots.js";

// One aliasing rule over the address spaces: static channels alias iff their
// byte ranges intersect; a dynamic GPR slot may alias every GPR word and a
// dynamic segment slot may alias every segment channel for the same field;
// guest memory may-alias guest memory (no disambiguation); guest memory and
// state never alias.

export type StorageEffect = StorageAccess;
export type ActionEffects = OperationEffects;

const noEffects: ActionEffects = { reads: [], writes: [] };

// A control action's signature is the union over its bodies — any one may
// be selected. The union is for legality only; demand stays per-body.
export function effectsOf(action: Action): ActionEffects {
  switch (action.kind) {
    case "op":
      return action.op.effects;
    case "if":
      return bodyEffects(action.thenBody, action.elseBody);
    case "switch":
      return bodyEffects(...action.cases.map((switchCase) => switchCase.body), action.defaultBody);
    case "loop":
      return bodyEffects(action.body);
    case "loopContinue":
    case "finish":
      return noEffects;
  }
}

function bodyEffects(...bodies: readonly (Body | undefined)[]): ActionEffects {
  const reads: StorageEffect[] = [];
  const writes: StorageEffect[] = [];

  for (const body of bodies) {
    if (body === undefined) {
      continue;
    }

    for (const action of body.actions) {
      const effects = effectsOf(action);

      reads.push(...effects.reads);
      writes.push(...effects.writes);
    }
  }

  return { reads, writes };
}

export function mayAlias(a: StorageEffect, b: StorageEffect): boolean {
  switch (a.space) {
    case "memory":
      return b.space === "memory";
    case "memoryBounds":
      return b.space === "memoryBounds";
    case "state":
      return b.space === "state" && slotsMayAlias(a.slot, b.slot);
    case "var":
      return b.space === "var" && a.variable === b.variable;
  }
}

export function slotsMayAlias(a: StateSlot, b: StateSlot): boolean {
  switch (a.kind) {
    case "gprDynamic":
      return b.kind === "gpr" || b.kind === "gprDynamic";
    case "segmentDynamic":
      return (b.kind === "segmentDynamic" || b.kind === "segment") && a.field === b.field;
    case "gpr":
      return isDynamicSlot(b) ? b.kind === "gprDynamic" : channelsOverlap(a, b);
    case "flag":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return !isDynamicSlot(b) && channelsOverlap(a, b);
    case "segment":
      return isDynamicSlot(b)
        ? b.kind === "segmentDynamic" && a.field === b.field
        : channelsOverlap(a, b);
  }
}

export function actionMayWriteStateSlot(action: Action, slot: StateSlot): boolean {
  switch (action.kind) {
    case "op":
      return action.op.effects.writes.some(
        (write) => write.space === "state" && slotsMayAlias(write.slot, slot)
      );
    case "if":
      return bodyMayWriteStateSlot(action.thenBody, slot) ||
        (action.elseBody !== undefined && bodyMayWriteStateSlot(action.elseBody, slot));
    case "switch":
      return action.cases.some((switchCase) => bodyMayWriteStateSlot(switchCase.body, slot)) ||
        bodyMayWriteStateSlot(action.defaultBody, slot);
    case "loop":
      return bodyMayWriteStateSlot(action.body, slot);
    case "loopContinue":
    case "finish":
      return false;
  }
}

export function bodyMayWriteStateSlot(body: Body, slot: StateSlot): boolean {
  return body.actions.some((action) => actionMayWriteStateSlot(action, slot));
}
