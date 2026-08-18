import { assert } from "#common/assert.js";
import type { Integer, I32Value } from "#compiler/function/values.js";
import type { OperandWidth, SegmentRegister } from "#core/types.js";
import type { BoundStateAccess } from "#core/state/access.js";
import { segmentBaseChannel, segmentSelectorChannel } from "#core/state/channels.js";
import type { StateFieldTracker } from "./field-tracker.js";

type SegmentStateSnapshot = Readonly<{
  dynamicBases: readonly DynamicSegmentBase[];
}>;

type DynamicSegmentBase = Readonly<{
  index: Integer<8>;
  value: I32Value;
}>;

// Selector and base state only. The terminal owns selector-write policy.
export class SegmentState {
  readonly #state: StateFieldTracker;
  readonly #dynamicBases: DynamicSegmentBase[] = [];

  constructor(state: StateFieldTracker) {
    this.#state = state;
  }

  beginInstruction(): void {
    this.#dynamicBases.length = 0;
  }

  snapshot(): SegmentStateSnapshot {
    return { dynamicBases: [...this.#dynamicBases] };
  }

  restore(snapshot: SegmentStateSnapshot): void {
    this.#dynamicBases.length = 0;

    this.#dynamicBases.push(...snapshot.dynamicBases);
  }

  readSelector(
    access: BoundStateAccess,
    reg: SegmentRegister,
    accessWidth: OperandWidth
  ): I32Value {
    return this.#widthAdjusted(this.#state.read(access, segmentSelectorChannel(reg)), accessWidth);
  }

  readDynamicSelector(
    access: BoundStateAccess,
    index: Integer<8>,
    accessWidth: OperandWidth
  ): I32Value {
    return this.#widthAdjusted(
      access.read(access.dynamicSegment(index, "selector")).unsigned.extend(32),
      accessWidth
    );
  }

  readBase(access: BoundStateAccess, reg: SegmentRegister): I32Value {
    return this.#state.read(access, segmentBaseChannel(reg));
  }

  readDynamicBase(access: BoundStateAccess, index: Integer<8>): I32Value {
    const cached = this.#dynamicBases.find((entry) => access.sameValue(entry.index, index));

    if (cached !== undefined) {
      return cached.value;
    }

    const base = access.read(access.dynamicSegment(index, "base"));

    this.#dynamicBases.push({ index, value: base });
    return base;
  }

  #widthAdjusted(value: I32Value, accessWidth: OperandWidth): I32Value {
    assert(accessWidth === 16 || accessWidth === 32, `${accessWidth}-bit segment selector read`);

    return value.truncate(accessWidth).unsigned.extend(32);
  }
}
