import { channelsOverlap, isDynamicSlot } from "./slots.js";
import type { Action } from "./actions.js";
import type { Body } from "./block.js";
import { opReads, opWrites, type StorageAccess } from "./ops.js";
import type { StateSlot } from "./slots.js";

// Effects are derived from action kind + slot, never stored per-action.
// One aliasing rule over the address spaces: static channels alias iff their
// byte ranges intersect; a dynamic GPR slot may alias every GPR word and a
// dynamic segment slot may alias every segment channel for the same field;
// guest memory may-alias guest memory (no disambiguation); guest memory and
// state never alias.

export type StorageEffect = StorageAccess;

export type ActionEffects = Readonly<{
  reads: readonly StorageEffect[];
  writes: readonly StorageEffect[];
}>;

const noEffects: ActionEffects = { reads: [], writes: [] };

export function effectsOf(action: Action): ActionEffects {
  switch (action.kind) {
    case "op":
      return {
        reads: opReads(action.op),
        writes: opWrites(action.op)
      };
    case "guardMemory":
      // A guard checks bounds; it touches no data.
      return noEffects;
    case "if":
      return bodyEffects(action.thenBody, action.elseBody);
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
    case "state":
      return b.space === "state" && slotsMayAlias(a.slot, b.slot);
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
      return opWrites(action.op).some((write) => write.space === "state" && slotsMayAlias(write.slot, slot));
    case "guardMemory":
      return false;
    case "if":
      return bodyMayWriteStateSlot(action.thenBody, slot) ||
        (action.elseBody !== undefined && bodyMayWriteStateSlot(action.elseBody, slot));
    case "finish":
      return false;
  }
}

export function bodyMayWriteStateSlot(body: Body, slot: StateSlot): boolean {
  return body.actions.some((action) => actionMayWriteStateSlot(action, slot));
}
