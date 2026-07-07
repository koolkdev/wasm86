import { assert } from "#common/assert.js";
import type { RegName } from "#x86/types.js";
import type { LoopCarriedCell, StateWriteAction } from "../../actions.js";
import {
  channelCovers,
  channelsOverlap,
  gprChannel,
  instructionCountChannel,
  isDynamicSlot,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  type StateChannel,
  type StateSlot
} from "../../slots.js";
import type { ValueId, ValueTable, WidthBounds } from "../../values.js";
import { channelReadBounds } from "./cells.js";
import type { State } from "./index.js";

type LoopCell = Required<LoopCarriedCell>;

export type StateLoopOptions = Readonly<{
  regs?: readonly RegName[];
  statusFlags: boolean;
  instructionCount: boolean;
}>;

export class StateLoopScope {
  readonly #values: ValueTable;
  readonly #state: State;
  readonly #carried: readonly StateChannel[];
  readonly #carriesStatusFlags: boolean;
  readonly #carriesInstructionCount: boolean;
  #cells: readonly LoopCell[] | undefined;

  constructor(
    values: ValueTable,
    state: State,
    options: StateLoopOptions
  ) {
    this.#values = values;
    this.#state = state;
    this.#carriesStatusFlags = options.statusFlags;
    this.#carriesInstructionCount = options.instructionCount;
    this.#carried = [
      ...(options.regs ?? []).map((reg) => gprChannel(reg)),
      ...(options.instructionCount ? [instructionCountChannel] : []),
      ...(options.statusFlags ? [lazyFlagsKindChannel, lazyFlagsAChannel, lazyFlagsBChannel] : [])
    ];

    for (const [index, channel] of this.#carried.entries()) {
      assert(
        this.#carried.slice(0, index).every((existing) => !channelsOverlap(existing, channel)),
        "loop state registers must not overlap"
      );
    }
  }

  begin(): readonly LoopCell[] {
    assert(this.#cells === undefined, "loop state scope is already open");

    // Seeds come first: the reads flush and fold pre-loop tracked state before
    // the carried cells take over their channels.
    const cells = this.#carried.map((channel) => ({
      channel,
      seed: this.#state.readChannel(channel),
      loopInput: this.#values.addLoopInput(loopInputBounds(channel))
    }));

    for (const cell of cells) {
      this.#state.writeChannel(cell.channel, cell.loopInput);
    }

    // The iteration top is the fault boundary: carried cells snapshot as
    // their loop inputs, so mid-body faults report iteration-start state.
    this.#state.beginInstructionBoundary();

    this.#cells = cells;
    return cells;
  }

  captureExitValues(): readonly ValueId[] {
    return this.#openCells().map((cell) => this.#state.readChannel(cell.channel));
  }

  captureContinueValues(): readonly ValueId[] {
    return this.#openCells().map((cell) => this.#state.readChannel(cell.channel));
  }

  restoreExitValues(exitValues: readonly ValueId[]): void {
    this.#openCells().forEach((cell, index) => {
      this.#state.writeChannel(cell.channel, exitValues[index]!);
    });
  }

  assertExitValues(exitValues: readonly ValueId[]): void {
    this.#openCells().forEach((cell, index) => {
      assert(
        this.#state.readChannel(cell.channel) === exitValues[index],
        "carried channels must not change after the back edge"
      );
    });
  }

  commitExitValues(exitValues: readonly ValueId[]): readonly StateWriteAction[] {
    return this.#openCells().map((cell, index) => ({
      kind: "op",
      op: { kind: "state.write", slot: cell.channel, value: exitValues[index]! }
    }));
  }

  close(): void {
    for (const cell of this.#openCells()) {
      this.#state.invalidate(cell.channel);
    }

    if (this.#carriesStatusFlags) {
      this.#state.statusFlags.resetToInputs();
    }
  }

  assertHoistableRead(slot: StateSlot): void {
    assert(slot.kind !== "gprDynamic", "dynamic register reads inside a loop body are unsupported");
    assert(
      isDynamicSlot(slot) || !this.isCarried(slot),
      "carried channels resolve through loop cells; no state.read may target one inside a loop body"
    );
  }

  assertDynamicWriteSupported(slot: StateSlot): void {
    assert(!isDynamicSlot(slot), "dynamic state writes inside a loop body are unsupported");
  }

  carriesStatusFlags(): boolean {
    return this.#carriesStatusFlags;
  }

  carriesInstructionCount(): boolean {
    return this.#carriesInstructionCount;
  }

  // A loop body may only write channels it carries; any other write is silently
  // dropped, since only carried cells commit. Narrow carries are exact: carrying
  // al lets the body write al, but an ax/eax write asserts.
  assertWritableChannel(channel: StateChannel): void {
    assert(
      this.#carried.some((carried) => channelCovers(carried, channel) && channelCovers(channel, carried)),
      `loop body writes an uncarried state channel: ${JSON.stringify(channel)}`
    );
  }

  isCarried(channel: StateChannel): boolean {
    return this.#carried.some((carried) => channelsOverlap(carried, channel));
  }

  #openCells(): readonly LoopCell[] {
    assert(this.#cells !== undefined, "loop state scope is not open");
    return this.#cells;
  }
}

// A loop input is exactly as wide as a read of its channel.
function loopInputBounds(channel: StateChannel): WidthBounds | undefined {
  return channel.kind === "gpr" ? undefined : channelReadBounds(channel);
}
