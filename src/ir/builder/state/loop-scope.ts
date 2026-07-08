import { assert } from "#common/assert.js";
import type { LoopCarriedCell, StateWriteAction } from "../../actions.js";
import {
  channelsOverlap,
  isDynamicSlot,
  type StateChannel,
  type StateSlot
} from "../../slots.js";
import type { ValueId, ValueTable, WidthBounds } from "../../values.js";
import { channelReadBounds } from "./cells.js";
import type { State } from "./index.js";

type LoopCell = Required<LoopCarriedCell>;

export class StateLoopScope {
  readonly #values: ValueTable;
  readonly #state: State;
  readonly #bodyWrites: readonly StateChannel[];
  #cells: readonly LoopCell[] | undefined;
  #dirtyAtEntry: ReadonlySet<StateChannel> = new Set();
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

    // The carried set is the body's write set, deduped in first-write order;
    // the exact-access rule rejects overlapping narrow writes (al then ax).
    const carried = [...new Set(this.#bodyWrites)];

    for (const [index, channel] of carried.entries()) {
      assert(
        channel.kind === "gpr" || channel.kind === "lazyFlags",
        `loop body writes unsupported state channel: ${JSON.stringify(channel)}`
      );
      assert(
        carried.slice(0, index).every((existing) => !channelsOverlap(existing, channel)),
        "overlapping loop-carried state writes are unsupported"
      );
    }

    // Entry values are the skipped-path contribution to the join. Reading
    // them first also flushes/folds tracked state before loop inputs take over.
    const cells = carried.map((channel) => ({
      channel,
      seed: this.#state.readChannel(channel),
      loopInput: this.#values.addLoopInput(loopInputBounds(channel))
    }));

    // The skipped arm only needs generated commits for values that existed
    // solely in pending state at entry. Clean memory-backed channels already
    // read back as the entry contribution.
    this.#dirtyAtEntry = new Set(carried.filter((channel) => this.#state.isChannelDirty(channel)));

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
      op: { kind: "state.write", slot: cell.channel, value: exitValues[index]! }
    }));
  }

  // The zero-trip arm's commits: only dirty-at-entry channels, whose pre-loop
  // value survives nowhere but the seed once the ran arm consumes it.
  commitSeedValues(): readonly StateWriteAction[] {
    return this.#openCells()
      .filter((cell) => this.#dirtyAtEntry.has(cell.channel))
      .map((cell) => ({
        kind: "op",
        op: { kind: "state.write", slot: cell.channel, value: cell.seed }
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
