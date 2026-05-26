import type { BlockContinuation } from "#x86/block/actions.js";
import type { ExprRef } from "#x86/expr/types.js";
import type { ValueRef } from "#x86/ir/model/types.js";
import type { BlockWalkRecorder } from "./recorder.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class ControlWalkOps {
  readonly #recorder: BlockWalkRecorder;
  readonly #site: () => OpSite;
  readonly #snapshot: () => BlockState;
  readonly #continuation: ExprRef | undefined;
  readonly #value: (value: ValueRef) => ExprRef;

  constructor(input: Readonly<{
    recorder: BlockWalkRecorder;
    site: () => OpSite;
    snapshot: () => BlockState;
    continuation: ExprRef | undefined;
    value: (value: ValueRef) => ExprRef;
  }>) {
    this.#recorder = input.recorder;
    this.#site = input.site;
    this.#snapshot = input.snapshot;
    this.#continuation = input.continuation;
    this.#value = input.value;
  }

  jump(target: ExprRef): void {
    const at = this.#site();
    const exit = this.#recorder.exit(
      at,
      this.#snapshot(),
      "jump",
      Object.freeze({ kind: "jump", target })
    );

    this.#recorder.action(Object.freeze({
      kind: "jump",
      at,
      target,
      exit
    }));
  }

  branch(condition: ExprRef, takenTarget: ExprRef, notTaken: ValueRef): void {
    const at = this.#site();
    const snapshot = this.#snapshot();
    const continuation = this.#branchContinuation(notTaken);
    const taken = this.#recorder.exit(
      at,
      snapshot,
      "branchTaken",
      Object.freeze({ kind: "branch", direction: "taken", target: takenTarget })
    );
    const notTakenExit = this.#recorder.exit(
      at,
      snapshot,
      "branchNotTaken",
      Object.freeze({ kind: "branch", direction: "notTaken" })
    );

    this.#recorder.action(Object.freeze({
      kind: "branch",
      at,
      condition,
      takenTarget,
      continuation,
      taken,
      notTaken: notTakenExit
    }));
  }

  hostTrap(vector: ExprRef): void {
    const at = this.#site();
    const exit = this.#recorder.exit(
      at,
      this.#snapshot(),
      "hostTrap",
      Object.freeze({ kind: "hostTrap", vector })
    );

    this.#recorder.action(Object.freeze({
      kind: "hostTrap",
      at,
      vector,
      exit
    }));
  }

  fallthrough(): void {
    const at = this.#site();
    const continuation = this.#fallthroughContinuation();
    const exit = this.#recorder.exit(
      at,
      this.#snapshot(),
      "fallthrough",
      Object.freeze({ kind: "fallthrough" })
    );

    this.#recorder.action(Object.freeze({
      kind: "fallthrough",
      at,
      continuation,
      exit
    }));
  }

  #branchContinuation(value: ValueRef): BlockContinuation {
    if (value.kind === "nextEip") {
      return this.#fallthroughContinuation();
    }

    return Object.freeze({ kind: "continuation", value: this.#value(value) });
  }

  #fallthroughContinuation(): BlockContinuation {
    return this.#continuation === undefined
      ? Object.freeze({ kind: "continuation" })
      : Object.freeze({ kind: "continuation", value: this.#continuation });
  }
}
