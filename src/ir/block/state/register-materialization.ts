import { registerAlias } from "#x86/registers.js";
import { reg32, type Reg32 } from "#x86/types.js";
import type { ExprRef } from "#ir/expr/types.js";
import { exprsEqual } from "#ir/expr/equality.js";
import {
  registerMaterializationWrite,
  resetWritesForUncoveredOverlay,
  type RegisterMaterializationWrite
} from "./register-overlays.js";
import type { registerAliasWrite } from "./register-overlays.js";
import type { RegisterState } from "./register-state.js";

export type { RegisterMaterializationWrite } from "./register-overlays.js";

export type RegisterAccessMode =
  | "exact-alias"
  | "full-base";

type RegisterBaseSnapshot = Readonly<{
  base: Reg32;
  baseValue: ExprRef;
  overlays: readonly ReturnType<typeof registerAliasWrite>[];
}>;

type RegisterMaterializationState = RegisterState & Readonly<{
  baseState(reg: Reg32): RegisterBaseSnapshot;
}>;

export class RegisterMaterializer {
  readonly #mode: RegisterAccessMode;

  constructor(mode: RegisterAccessMode) {
    this.#mode = mode;
  }

  writes(
    baseline: RegisterState,
    snapshot: RegisterState
  ): readonly RegisterMaterializationWrite[] {
    switch (this.#mode) {
      case "exact-alias":
        return exactAliasRegisterMaterializationWrites(baseline, snapshot);
      case "full-base":
        return fullBaseRegisterMaterializationWrites(baseline, snapshot);
    }
  }
}

function exactAliasRegisterMaterializationWrites(
  baseline: RegisterState,
  snapshot: RegisterState
): readonly RegisterMaterializationWrite[] {
  const baselineState = asMaterializationState(baseline);
  const snapshotState = asMaterializationState(snapshot);

  return Object.freeze(reg32.flatMap((base) =>
    new RegisterBaseMaterializationPlanner(
      base,
      baselineState,
      snapshotState
    ).writes()
  ));
}

function fullBaseRegisterMaterializationWrites(
  baseline: RegisterState,
  snapshot: RegisterState
): readonly RegisterMaterializationWrite[] {
  return Object.freeze(reg32.flatMap((base) => {
    const snapshotValue = snapshot.read(base);

    return exprsEqual(baseline.read(base), snapshotValue)
      ? []
      : [registerMaterializationWrite(registerAlias(base), snapshotValue)];
  }));
}

class RegisterBaseMaterializationPlanner {
  readonly #base: Reg32;
  readonly #baseline: RegisterMaterializationState;
  readonly #snapshot: RegisterMaterializationState;
  readonly #baselineBase: RegisterBaseSnapshot;
  readonly #snapshotBase: RegisterBaseSnapshot;
  #state: RegisterMaterializationState;
  readonly #writes: RegisterMaterializationWrite[] = [];

  constructor(
    base: Reg32,
    baseline: RegisterMaterializationState,
    snapshot: RegisterMaterializationState
  ) {
    this.#base = base;
    this.#baseline = baseline;
    this.#snapshot = snapshot;
    this.#baselineBase = baseline.baseState(base);
    this.#snapshotBase = snapshot.baseState(base);
    this.#state = baseline;
  }

  writes(): readonly RegisterMaterializationWrite[] {
    if (exprsEqual(this.#baseline.read(this.#base), this.#snapshot.read(this.#base))) {
      return [];
    }

    if (!exprsEqual(this.#baselineBase.baseValue, this.#snapshotBase.baseValue)) {
      return this.#replaceBaseThenOverlays();
    }

    this.#resetRemovedBaselineOverlays();
    this.#applySnapshotOverlays();

    return this.#reachesSnapshot()
      ? Object.freeze(this.#writes)
      : [registerMaterializationWrite(registerAlias(this.#base), this.#snapshot.read(this.#base))];
  }

  #replaceBaseThenOverlays(): readonly RegisterMaterializationWrite[] {
    return [
      registerMaterializationWrite(registerAlias(this.#base), this.#snapshotBase.baseValue),
      ...this.#snapshotBase.overlays.map((write) =>
        registerMaterializationWrite(write.reg, write.value)
      )
    ];
  }

  #resetRemovedBaselineOverlays(): void {
    for (const write of this.#baselineBase.overlays) {
      for (const reset of resetWritesForUncoveredOverlay(
        write,
        this.#snapshotBase.overlays,
        this.#snapshotBase.baseValue
      )) {
        this.#recordIfChanged(reset);
      }
    }
  }

  #applySnapshotOverlays(): void {
    for (const write of this.#snapshotBase.overlays) {
      this.#recordIfChanged(registerMaterializationWrite(write.reg, write.value));
    }
  }

  #recordIfChanged(write: RegisterMaterializationWrite): void {
    if (exprsEqual(this.#state.readAlias(write.reg), write.value)) {
      return;
    }

    this.#writes.push(write);
    this.#state = asMaterializationState(this.#state.writeAlias(write.reg, write.value));
  }

  #reachesSnapshot(): boolean {
    return exprsEqual(this.#state.read(this.#base), this.#snapshot.read(this.#base));
  }
}

function asMaterializationState(state: RegisterState): RegisterMaterializationState {
  return state as RegisterMaterializationState;
}
