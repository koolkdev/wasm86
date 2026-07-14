import { assert } from "#common/assert.js";
import { stateWrite } from "#compiler/ir/operations/state.js";
import type { LoopCarriedCell, StateWriteAction } from "../../actions.js";
import {
  dedupeDisjointChannels, channelsOverlap, isDynamicSlot, type StateChannel, type StateSlot
} from "../../slots.js";
import type { ValueId, WidthBounds } from "#compiler/ir/values/types.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { channelReadBounds } from "./cells.js";
import type { State } from "./index.js";

type LoopCell = Required<LoopCarriedCell>;

export class StateLoopScope {
  readonly #values: ValueTable;
  readonly #state: State;
  readonly #bodyWrites: readonly StateChannel[];
  #cells: readonly LoopCell[] | undefined;
  #closed = false;

  constructor(
    values: ValueTable,
    state: State,
    bodyWrites: readonly StateChannel[]
  ) {
    this.#values = values;
    this.#state = state;
    this.#bodyWrites = bodyWrites;
  }

  begin(): readonly LoopCell[] {
    assert(this.#cells === undefined, "loop state scope is already open");

    const carried = dedupeDisjointChannels(this.#bodyWrites);

    for (const channel of carried) {
      assert(
        channel.kind === "gpr" || channel.kind === "lazyFlags",
        `loop body writes unsupported state channel: ${JSON.stringify(channel)}`
      );
    }

    // Entry values are the skipped-path contribution to the join. Reading
    // them first also flushes/folds tracked state before loop inputs take over.
    const cells = carried.map((channel) => ({
      channel,
      seed: this.#state.readChannel(channel),
      loopInput: this.#values.addLoopInput(loopInputBounds(channel))
    }));

    for (const cell of cells) {
      this.#state.writeChannel(cell.channel, cell.loopInput);
    }

    // The iteration top is the fault boundary: carried cells snapshot as
    // loop inputs, so mid-body faults report iteration-start state.
    this.#state.beginInstructionBoundary();

    this.#cells = cells;
    return cells;
  }

  captureExitValues(): readonly ValueId[] {
    return this.#openCells().map((cell) => this.#state.readChannel(cell.channel));
  }

  commitExitValues(exitValues: readonly ValueId[]): readonly StateWriteAction[] {
    return this.#openCells().map((cell, index) => ({
      kind: "op",
      op: stateWrite.create({ slot: cell.channel, value: exitValues[index]! })
    }));
  }

  close(): void {
    const cells = this.#openCells();

    for (const cell of cells) {
      this.#state.invalidate(cell.channel);
    }

    if (cells.some((cell) => cell.channel.kind === "lazyFlags")) {
      this.#state.statusFlags.resetToInputs();
    }

    this.#closed = true;
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

  isCarried(channel: StateChannel): boolean {
    return this.#openCells().some((cell) => channelsOverlap(cell.channel, channel));
  }

  #openCells(): readonly LoopCell[] {
    assert(this.#cells !== undefined && !this.#closed, "loop state scope is not open");
    return this.#cells;
  }
}

function loopInputBounds(channel: StateChannel): WidthBounds | undefined {
  return channel.kind === "gpr" ? undefined : channelReadBounds(channel);
}
