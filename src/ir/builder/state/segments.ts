import { assert } from "#common/assert.js";
import type { OperandWidth, SegmentRegister } from "#core/types.js";
import type { BodyBuilder } from "../../body-builder.js";
import { segmentBaseChannel, type SegmentChannel } from "../../slots.js";
import { type ValueId } from "#compiler/ir/values/types.js";
import type { ValueTable } from "#compiler/ir/values/table.js";
import type { StateCells } from "./cells.js";

export type SegmentReadOptions = Readonly<{
  signed?: boolean;
}>;

type SegmentStateSnapshot = Readonly<{
  dynamicBases: ReadonlyMap<number, ValueId>;
}>;

// Selector and base cells only; what a selector *write* means is mode policy
// and lives with the finish emitter.
export class SegmentState {
  readonly #values: ValueTable;
  readonly #cells: StateCells;
  readonly #currentBody: () => BodyBuilder;
  readonly #dynamicBases = new Map<number, ValueId>();

  constructor(
    values: ValueTable,
    cells: StateCells,
    currentBody: () => BodyBuilder
  ) {
    this.#values = values;
    this.#cells = cells;
    this.#currentBody = currentBody;
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
    channel: SegmentChannel<SegmentRegister, "selector">,
    accessWidth: OperandWidth,
    options: SegmentReadOptions
  ): ValueId {
    return this.#widthAdjusted(this.#cells.read(channel), accessWidth, options);
  }

  readDynamicSelector(index: ValueId, accessWidth: OperandWidth, options: SegmentReadOptions): ValueId {
    return this.#widthAdjusted(
      this.#currentBody().opValue({ kind: "state.read", slot: { kind: "segmentDynamic", index, field: "selector" } }),
      accessWidth,
      options
    );
  }

  readBase(reg: SegmentRegister): ValueId {
    return this.#cells.read(segmentBaseChannel(reg));
  }

  readDynamicBase(index: ValueId): ValueId {
    let base = this.#dynamicBases.get(index);

    if (base === undefined) {
      base = this.#currentBody().opValue({ kind: "state.read", slot: { kind: "segmentDynamic", index, field: "base" } });
      this.#dynamicBases.set(index, base);
    }

    return base;
  }

  #widthAdjusted(value: ValueId, accessWidth: OperandWidth, options: SegmentReadOptions): ValueId {
    assert(accessWidth === 16 || accessWidth === 32, `${accessWidth}-bit segment selector read`);

    return options.signed === true
      ? this.#values.extend(accessWidth, value, true)
      : this.#values.truncate(accessWidth, value);
  }
}
