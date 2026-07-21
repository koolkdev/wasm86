import { assert } from "#common/assert.js";
import type { OperandWidth, SegmentRegister } from "#core/types.js";
import type { BoundStateAccess } from "#core/state/access.js";
import { segmentBaseChannel, segmentSelectorChannel } from "#core/state/channels.js";
import { type ValueId } from "#compiler/ir/values/types.js";
import type { StateFieldTracker } from "./field-tracker.js";

export type SegmentReadOptions = Readonly<{
  signed?: boolean;
}>;

type SegmentStateSnapshot = Readonly<{
  dynamicBases: ReadonlyMap<number, ValueId>;
}>;

// Selector and base state only. The terminal owns selector-write policy.
export class SegmentState {
  readonly #state: StateFieldTracker;
  readonly #dynamicBases = new Map<number, ValueId>();

  constructor(state: StateFieldTracker) {
    this.#state = state;
  }

  beginInstruction(): void {
    this.#dynamicBases.clear();
  }

  snapshot(): SegmentStateSnapshot {
    return { dynamicBases: new Map(this.#dynamicBases) };
  }

  restore(snapshot: SegmentStateSnapshot): void {
    this.#dynamicBases.clear();

    for (const [index, value] of snapshot.dynamicBases) {
      this.#dynamicBases.set(index, value);
    }
  }

  readSelector(
    access: BoundStateAccess,
    reg: SegmentRegister,
    accessWidth: OperandWidth,
    options: SegmentReadOptions
  ): ValueId {
    return this.#widthAdjusted(
      access,
      this.#state.read(access, segmentSelectorChannel(reg)),
      accessWidth,
      options
    );
  }

  readDynamicSelector(
    access: BoundStateAccess,
    index: ValueId,
    accessWidth: OperandWidth,
    options: SegmentReadOptions
  ): ValueId {
    return this.#widthAdjusted(
      access,
      access.read(access.dynamicSegment(index, "selector")),
      accessWidth,
      options
    );
  }

  readBase(access: BoundStateAccess, reg: SegmentRegister): ValueId {
    return this.#state.read(access, segmentBaseChannel(reg));
  }

  readDynamicBase(access: BoundStateAccess, index: ValueId): ValueId {
    let base = this.#dynamicBases.get(index);

    if (base === undefined) {
      base = access.read(access.dynamicSegment(index, "base"));
      this.#dynamicBases.set(index, base);
    }

    return base;
  }

  #widthAdjusted(
    access: BoundStateAccess,
    value: ValueId,
    accessWidth: OperandWidth,
    options: SegmentReadOptions
  ): ValueId {
    assert(accessWidth === 16 || accessWidth === 32, `${accessWidth}-bit segment selector read`);

    return options.signed === true
      ? access.values.extend(accessWidth, value, true)
      : access.values.truncate(accessWidth, value);
  }
}
