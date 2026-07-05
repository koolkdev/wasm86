import { assert } from "#common/assert.js";
import { segmentRegisterIndex } from "#x86/segments.js";
import type { OperandWidth, SegmentRegister } from "#x86/types.js";
import type { SegmentDynamicOperandBinding, SegmentOperandBinding } from "./operands.js";
import type { Action, Finish } from "./actions.js";
import type { PendingState } from "./pending/state.js";
import { segmentBaseChannel, type SegmentChannel } from "./slots.js";
import { type ValueId, type ValueTable } from "./values.js";

export type SegmentMode = "flat32";

export type SegmentReadOptions = Readonly<{
  signed?: boolean;
}>;

export type SegmentTerminator = (finish: Finish, actions: readonly Action[]) => void;

export class Segments {
  readonly #values: ValueTable;
  readonly #pending: PendingState;
  readonly #mode: SegmentMode;
  readonly #terminate: SegmentTerminator;
  readonly #dynamicBases = new Map<number, ValueId>();

  constructor(
    values: ValueTable,
    pending: PendingState,
    mode: SegmentMode,
    terminate: SegmentTerminator
  ) {
    this.#values = values;
    this.#pending = pending;
    this.#mode = mode;
    this.#terminate = terminate;
  }

  beginInstruction(): void {
    this.#dynamicBases.clear();
  }

  readSelector(
    channel: SegmentChannel<SegmentRegister, "selector">,
    accessWidth: OperandWidth,
    options: SegmentReadOptions
  ): ValueId {
    return this.#widthAdjusted(this.#pending.read(channel), accessWidth, options);
  }

  readDynamicSelector(index: ValueId, accessWidth: OperandWidth, options: SegmentReadOptions): ValueId {
    return this.#widthAdjusted(this.#pending.readDynamicSegmentSelector(index), accessWidth, options);
  }

  readBase(reg: SegmentRegister): ValueId {
    return this.#pending.read(segmentBaseChannel(reg));
  }

  readDynamicBase(index: ValueId): ValueId {
    let base = this.#dynamicBases.get(index);

    if (base === undefined) {
      base = this.#pending.readDynamicSegmentBase(index);
      this.#dynamicBases.set(index, base);
    }

    return base;
  }

  writeSelector(binding: SegmentOperandBinding | SegmentDynamicOperandBinding, selector: ValueId): void {
    switch (this.#mode) {
      case "flat32":
        this.#terminate(
          {
            kind: "exit",
            exit: {
              class: "host",
              reason: "segmentLoad",
              payload: this.#loadPayload(binding, selector)
            }
          },
          this.#pending.flushesForPath("fault")
        );
        return;
    }
  }

  #loadPayload(binding: SegmentOperandBinding | SegmentDynamicOperandBinding, selector: ValueId): ValueId {
    switch (binding.kind) {
      case "segment":
        return this.#staticLoadPayload(binding.channel.reg, selector);
      case "segmentDynamic":
        return this.#dynamicLoadPayload(binding.index, selector);
    }
  }

  #staticLoadPayload(reg: SegmentRegister, selector: ValueId): ValueId {
    return this.#values.binary(
      "or",
      this.#values.const(segmentRegisterIndex(reg) << 16),
      this.#values.truncate(16, selector)
    );
  }

  #dynamicLoadPayload(index: number, selector: ValueId): ValueId {
    return this.#values.binary(
      "or",
      this.#values.binary("shl", this.#values.external(index), this.#values.const(16)),
      this.#values.truncate(16, selector)
    );
  }

  #widthAdjusted(value: ValueId, accessWidth: OperandWidth, options: SegmentReadOptions): ValueId {
    assert(accessWidth === 16 || accessWidth === 32, `${accessWidth}-bit segment selector read`);

    return options.signed === true
      ? this.#values.extend(accessWidth, value, true)
      : this.#values.truncate(accessWidth, value);
  }
}
