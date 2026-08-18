import { assert } from "#common/assert.js";
import { isLazyFlagStateField } from "#core/flags/layout.js";
import type { InstructionStateChannel } from "./channels.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import type { I32Value } from "#compiler/function/values.js";
import { mayAlias } from "#compiler/function/storage.js";
import type { InstructionState } from "./state.js";
import type { BoundStateAccess } from "#core/state/access.js";
import type { StateWriteback } from "./writeback.js";

type LoopCarriedState = Readonly<{
  channel: InstructionStateChannel;
  seed: I32Value;
}>;

export class StateLoopScope {
  readonly #state: InstructionState;
  readonly #bodyWrites: readonly InstructionStateChannel[];
  #carried: readonly LoopCarriedState[] | undefined;
  #entered = false;
  #closed = false;

  constructor(state: InstructionState, bodyWrites: readonly InstructionStateChannel[]) {
    this.#state = state;
    this.#bodyWrites = bodyWrites;
  }

  begin(access: BoundStateAccess): readonly LoopCarriedState[] {
    assert(this.#carried === undefined, "loop state scope is already open");

    const carried = this.#state.dedupeDisjointChannels(this.#bodyWrites);

    for (const channel of carried) {
      assert(
        channel.kind === "gpr" || (channel.kind === "field" && isLazyFlagStateField(channel)),
        `loop body writes unsupported state channel: ${JSON.stringify(channel)}`
      );
    }

    // Entry values are the skipped-path contribution to the join. Reading
    // them first also flushes/folds tracked state before loop inputs take over.
    const values = carried.map((channel) => ({
      channel,
      seed: this.#state.readChannel(access, channel)
    }));

    this.#carried = values;
    return values;
  }

  enter(access: BoundStateAccess, inputs: readonly I32Value[]): void {
    const carried = this.#openCarried();

    assert(!this.#entered, "loop state scope is already entered");
    assert(
      inputs.length === carried.length,
      "loop state inputs do not align with carried channels"
    );
    for (const [index, value] of carried.entries()) {
      const input = inputs[index];

      assert(input !== undefined, `loop state ${index} has no input`);
      this.#state.writeChannel(access, value.channel, input);
    }

    // The iteration top is the fault boundary: carried values snapshot as
    // loop inputs, so mid-body faults report iteration-start state.
    this.#state.beginInstructionBoundary();

    this.#entered = true;
  }

  captureExitValues(access: BoundStateAccess): readonly I32Value[] {
    return this.#openCarried().map((value) => this.#state.readChannel(access, value.channel));
  }

  exitWritebacks(
    access: BoundStateAccess,
    exitValues: readonly I32Value[]
  ): readonly StateWriteback[] {
    return this.#openCarried().map((value, index) => {
      const exitValue = exitValues[index];

      assert(exitValue !== undefined, `loop state ${index} has no exit value`);
      return this.#state.writeback(access, value.channel, exitValue);
    });
  }

  close(): void {
    const carried = this.#openCarried();

    assert(this.#entered, "loop state scope was not entered");
    for (const value of carried) {
      this.#state.invalidate(value.channel);
    }

    if (
      carried.some((value) => value.channel.kind === "field" && isLazyFlagStateField(value.channel))
    ) {
      // This keeps a later resolver inside an arm from publishing a carried
      // lazy value that has no iteration-start value to restore.
      this.#state.statusFlags.resetToInputs();
    }

    this.#closed = true;
  }

  resourceReadPlacement(effect: ResourceEffect): "entry" | "body" {
    if (!this.#state.owns(effect)) {
      return "body";
    }

    // Semantic loops exclude dynamic GPR reads. A dynamic segment base is
    // loop-invariant like any static non-carried channel because segment loads
    // stay outside loop bodies and terminate their surrounding block.
    assert(
      this.#openCarried().every((value) => !mayAlias(this.#state.effect(value.channel), effect)),
      "an execution-state read overlaps loop-carried state"
    );
    return "entry";
  }

  #openCarried(): readonly LoopCarriedState[] {
    assert(this.#carried !== undefined && !this.#closed, "loop state scope is not open");
    return this.#carried;
  }
}
