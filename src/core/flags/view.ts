import type { X86Flag } from "./definitions.js";

export interface FlagStateView {
  readFlag(flag: X86Flag): boolean;
}

export interface MutableFlagStateView extends FlagStateView {
  writeFlag(flag: X86Flag, value: boolean): void;
}
