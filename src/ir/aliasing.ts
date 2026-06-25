import { channelsOverlap } from "./slots.js";
import type { Action, StateSlot } from "./actions.js";
import { x86StatusFlags, type X86Flag } from "#x86/flags.js";

// Effects are derived from action kind + slot, never stored per-action.
// One aliasing rule over the address spaces: static channels alias iff their
// byte ranges intersect; a dynamic GPR slot may alias every GPR word and
// never flags, lazy metadata, or eip; guest memory may-alias guest memory (no
// disambiguation); guest memory and state never alias.

export type StorageEffect =
  | Readonly<{ space: "state"; slot: StateSlot }>
  | Readonly<{ space: "memory" }>
  | Readonly<{ space: "statusFlags" }>;

export type ActionEffects = Readonly<{
  reads?: StorageEffect;
  writes?: StorageEffect;
}>;

const memoryEffect: StorageEffect = { space: "memory" };
const noEffects: ActionEffects = {};

export function effectsOf(action: Action): ActionEffects {
  switch (action.kind) {
    case "readState":
      return { reads: { space: "state", slot: action.slot } };
    case "writeState":
      return { writes: { space: "state", slot: action.slot } };
    case "commitFlags":
      return { writes: { space: "statusFlags" } };
    case "readMemory":
      return { reads: memoryEffect };
    case "writeMemory":
      return { writes: memoryEffect };
    case "guardMemory":
      // A guard checks bounds; it touches no data.
      return noEffects;
    case "branch":
    case "exit":
    case "continue":
      return noEffects;
  }
}

export function mayAlias(a: StorageEffect, b: StorageEffect): boolean {
  switch (a.space) {
    case "memory":
      return b.space === "memory";
    case "statusFlags":
      return b.space === "statusFlags" || (b.space === "state" && isCommitFlagsSlot(b.slot));
    case "state":
      return b.space === "statusFlags"
        ? isCommitFlagsSlot(a.slot)
        : b.space === "state" && slotsMayAlias(a.slot, b.slot);
  }
}

export function slotsMayAlias(a: StateSlot, b: StateSlot): boolean {
  switch (a.kind) {
    case "gprDynamic":
      return b.kind === "gpr" || b.kind === "gprDynamic";
    case "gpr":
      return b.kind === "gprDynamic" || channelsOverlap(a, b);
    case "flag":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return b.kind !== "gprDynamic" && channelsOverlap(a, b);
  }
}

export function actionMayWriteStateSlot(action: Action, slot: StateSlot): boolean {
  switch (action.kind) {
    case "writeState":
      return slotsMayAlias(action.slot, slot);
    case "commitFlags":
      return (slot.kind === "flag" && action.snapshot.values.some(({ flag }) => flag === slot.flag)) ||
        (slot.kind === "lazyFlags" && slot.field === "lazyFlagsKind");
    case "readState":
    case "readMemory":
    case "writeMemory":
    case "guardMemory":
    case "branch":
    case "exit":
    case "continue":
      return false;
  }
}

function isStatusFlagSlot(slot: StateSlot): boolean {
  return slot.kind === "flag" && (x86StatusFlags as readonly X86Flag[]).includes(slot.flag);
}

function isCommitFlagsSlot(slot: StateSlot): boolean {
  return isStatusFlagSlot(slot) || (slot.kind === "lazyFlags" && slot.field === "lazyFlagsKind");
}
