import { assert } from "#common/assert.js";
import { isLazyFlagStateField } from "#core/flags/layout.js";
import type { ResourceWriteArgs } from "#compiler/ir/operations/resource.js";
import type { InstructionStateChannel } from "./channels.js";
import type { ResourceEffect } from "#compiler/ir/resource.js";
import type { ValueId, WidthBounds } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { mayAlias } from "#ir/aliasing.js";
import { channelReadBounds } from "./field-tracker.js";
import type { InstructionState } from "./state.js";
import type { BoundStateAccess } from "#core/state/access.js";

export type LoopCarriedState = Readonly<{
  channel: InstructionStateChannel;
  seed: ValueId;
  loopInput: ValueId;
}>;

export class StateLoopScope {
  readonly #values: ValueTable;
  readonly #state: InstructionState;
  readonly #bodyWrites: readonly InstructionStateChannel[];
  #carried: readonly LoopCarriedState[] | undefined;
  #closed = false;

  constructor(
    values: ValueTable,
    state: InstructionState,
    bodyWrites: readonly InstructionStateChannel[]
  ) {
    this.#values = values;
    this.#state = state;
    this.#bodyWrites = bodyWrites;
  }

  begin(access: BoundStateAccess): readonly LoopCarriedState[] {
    assert(this.#carried === undefined, "loop state scope is already open");

    const carried = this.#state.dedupeDisjointChannels(this.#bodyWrites);

    for (const channel of carried) {
      assert(
        channel.kind === "gpr" ||
          (channel.kind === "field" && isLazyFlagStateField(channel)),
        `loop body writes unsupported state channel: ${JSON.stringify(channel)}`
      );
    }

    // Entry values are the skipped-path contribution to the join. Reading
    // them first also flushes/folds tracked state before loop inputs take over.
    const values = carried.map((channel) => ({
      channel,
      seed: this.#state.readChannel(access, channel),
      loopInput: this.#values.addLoopInput(loopInputBounds(channel))
    }));

    for (const value of values) {
      this.#state.writeChannel(access, value.channel, value.loopInput);
    }

    // The iteration top is the fault boundary: carried values snapshot as
    // loop inputs, so mid-body faults report iteration-start state.
    this.#state.beginInstructionBoundary();

    this.#carried = values;
    return values;
  }

  captureExitValues(access: BoundStateAccess): readonly ValueId[] {
    return this.#openCarried().map((value) =>
      this.#state.readChannel(access, value.channel)
    );
  }

  exitWritebacks(
    access: BoundStateAccess,
    exitValues: readonly ValueId[]
  ): readonly ResourceWriteArgs[] {
    return this.#openCarried().map((value, index) =>
      this.#state.writeback(access, value.channel, exitValues[index]!)
    );
  }

  close(): void {
    const carried = this.#openCarried();

    for (const value of carried) {
      this.#state.invalidate(value.channel);
    }

    if (carried.some(
      (value) => value.channel.kind === "field" &&
        isLazyFlagStateField(value.channel)
    )) {
      // This keeps a later resolver inside an arm from publishing a carried
      // lazy value that has no iteration-start value to restore.
      this.#state.statusFlags.resetToInputs();
    }

    this.#closed = true;
  }

  assertHoistableRead(effect: ResourceEffect): void {
    assert(
      this.#openCarried().every(
        (value) => !mayAlias(this.#state.effect(value.channel), effect)
      ),
      "an execution-state read overlaps loop-carried state"
    );
  }

  isExecutionStateEffect(effect: ResourceEffect): boolean {
    return this.#state.owns(effect);
  }

  #openCarried(): readonly LoopCarriedState[] {
    assert(
      this.#carried !== undefined && !this.#closed,
      "loop state scope is not open"
    );
    return this.#carried;
  }
}

function loopInputBounds(channel: InstructionStateChannel): WidthBounds | undefined {
  return channel.kind === "gpr" ? undefined : channelReadBounds(channel);
}
