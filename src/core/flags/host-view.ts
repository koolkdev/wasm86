import type { LayoutHostView } from "#compiler/layout/host-view.js";
import type { X86Flag } from "./definitions.js";
import { flagStateFields } from "./layout.js";
import type { MutableFlagStateView } from "./view.js";

export interface FlagStateHostView extends MutableFlagStateView {
  lazyKind: number;
  lazyA: number;
  lazyB: number;

  readFlagByte(flag: X86Flag): number;
  writeFlagByte(flag: X86Flag, value: number): void;
}

export function createFlagStateHostView(
  storage: LayoutHostView
): FlagStateHostView {
  return new FlagStateHostViewImpl(storage);
}

class FlagStateHostViewImpl implements FlagStateHostView {
  readonly #storage: LayoutHostView;

  constructor(storage: LayoutHostView) {
    this.#storage = storage;
  }

  get lazyKind(): number {
    return this.#storage.readField(flagStateFields.lazyKind);
  }

  set lazyKind(value: number) {
    this.#storage.writeField(flagStateFields.lazyKind, value);
  }

  get lazyA(): number {
    return this.#storage.readField(flagStateFields.lazyA);
  }

  set lazyA(value: number) {
    this.#storage.writeField(flagStateFields.lazyA, value);
  }

  get lazyB(): number {
    return this.#storage.readField(flagStateFields.lazyB);
  }

  set lazyB(value: number) {
    this.#storage.writeField(flagStateFields.lazyB, value);
  }

  readFlag(flag: X86Flag): boolean {
    return this.readFlagByte(flag) !== 0;
  }

  writeFlag(flag: X86Flag, value: boolean): void {
    this.writeFlagByte(flag, value ? 1 : 0);
  }

  readFlagByte(flag: X86Flag): number {
    return this.#storage.readField(flagStateFields.concrete[flag]);
  }

  writeFlagByte(flag: X86Flag, value: number): void {
    this.#storage.writeField(
      flagStateFields.concrete[flag],
      value === 0 ? 0 : 1
    );
  }
}
