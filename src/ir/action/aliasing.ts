import { channelsOverlap, type StateChannel } from "./slots.js";
import type { Action } from "./types.js";

// Effects are derived from action kind + slot, never stored per-action.
// One aliasing rule over the address spaces: static channels alias iff their
// byte ranges intersect; guest memory may-alias guest memory (no
// disambiguation); guest memory and state never alias.

export type StorageEffect =
  | Readonly<{ space: "state"; channel: StateChannel }>
  | Readonly<{ space: "memory" }>;

export type ActionEffects = Readonly<{
  reads?: StorageEffect;
  writes?: StorageEffect;
}>;

const memoryEffect: StorageEffect = { space: "memory" };
const noEffects: ActionEffects = {};

export function effectsOf(action: Action): ActionEffects {
  switch (action.kind) {
    case "readState":
      return { reads: { space: "state", channel: action.slot } };
    case "writeState":
      return { writes: { space: "state", channel: action.slot } };
    case "readMemory":
      return { reads: memoryEffect };
    case "writeMemory":
      return { writes: memoryEffect };
    case "guardMemory":
      // A guard checks bounds; it touches no data.
      return noEffects;
    case "branch":
    case "exit":
      return noEffects;
  }
}

export function mayAlias(a: StorageEffect, b: StorageEffect): boolean {
  switch (a.space) {
    case "memory":
      return b.space === "memory";
    case "state":
      return b.space === "state" && channelsOverlap(a.channel, b.channel);
  }
}
