import type { LayoutHostView } from "#compiler/layout/host-view.js";
import {
  isX86StatusFlag,
  x86StatusFlags,
  type X86Flag
} from "./definitions.js";
import { LAZY_FLAGS_KIND } from "./lazy/encoding.js";
import { resolveLazyStatusFlagBytes } from "./lazy/host.js";
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
    const lazyKind = this.lazyKind;

    if (
      isX86StatusFlag(flag) &&
      lazyKind !== LAZY_FLAGS_KIND.NONE
    ) {
      return resolveLazyStatusFlagBytes(
        lazyKind,
        this.lazyA,
        this.lazyB
      )[flag];
    }

    return this.#storage.readField(flagStateFields.concrete[flag]);
  }

  writeFlagByte(flag: X86Flag, value: number): void {
    const lazyKind = this.lazyKind;

    if (
      isX86StatusFlag(flag) &&
      lazyKind !== LAZY_FLAGS_KIND.NONE
    ) {
      const lazyA = this.lazyA;
      const lazyB = this.lazyB;
      const resolved = resolveLazyStatusFlagBytes(
        lazyKind,
        lazyA,
        lazyB
      );

      for (const statusFlag of x86StatusFlags) {
        this.#storage.writeField(
          flagStateFields.concrete[statusFlag],
          resolved[statusFlag]
        );
      }
      this.lazyKind = LAZY_FLAGS_KIND.NONE;
    }

    this.#storage.writeField(
      flagStateFields.concrete[flag],
      value === 0 ? 0 : 1
    );
  }
}
