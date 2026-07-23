import type { ValueId } from "#compiler/ir/values/types.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import type { StateFieldTracker } from "./field-tracker.js";
import type { BoundStateAccess } from "#core/state/access.js";

type InstructionCountStateSnapshot = Readonly<{
  base: ValueId | undefined;
  completed: number;
}>;

// Folds a run of increments into one add: the count field holds `base +
// completed`. Anything that changes the field outside increment() re-anchors the
// fold via #rebase, so a stale base is never reused.
export class InstructionCountState {
  readonly #state: StateFieldTracker;
  readonly #field: FieldRef<"u32">;
  #base: ValueId | undefined;
  #completed = 0;

  constructor(
    state: StateFieldTracker,
    field: FieldRef<"u32">
  ) {
    this.#state = state;
    this.#field = field;
  }

  read(access: BoundStateAccess): ValueId {
    return this.#state.read(access, this.#field);
  }

  increment(access: BoundStateAccess): void {
    this.#completed += 1;
    this.#state.write(this.#field, this.#advancedValue(access));
  }

  add(access: BoundStateAccess, value: ValueId): void {
    this.#state.write(
      this.#field,
      access.values.binary("add", this.read(access), value)
    );
    this.#rebase();
  }

  invalidate(): void {
    this.#state.invalidate(this.#field);
    this.#rebase();
  }

  snapshot(): InstructionCountStateSnapshot {
    return {
      base: this.#base,
      completed: this.#completed
    };
  }

  restore(snapshot: InstructionCountStateSnapshot): void {
    this.#base = snapshot.base;
    this.#completed = snapshot.completed;
  }

  #rebase(): void {
    this.#base = undefined;
    this.#completed = 0;
  }

  #advancedValue(access: BoundStateAccess): ValueId {
    this.#base ??= this.#state.read(access, this.#field);

    return access.values.binary(
      "add",
      this.#base,
      access.values.const(this.#completed)
    );
  }
}
