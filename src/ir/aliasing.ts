import { channelsOverlap, isDynamicSlot } from "./slots.js";
import type { Action } from "./actions.js";
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
    case "branch":
    case "finish":
      return noEffects;
  }
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
    case "branch":
    case "finish":
      return false;
  }
}
