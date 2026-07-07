import { assert } from "#common/assert.js";
import { segmentRegisterIndex } from "#x86/segments.js";
import type { OperandWidth, SegmentRegister } from "#x86/types.js";
import type { SegmentDynamicOperandBinding, SegmentOperandBinding } from "../../operands.js";
import type { Action, Finish } from "../../actions.js";
import { segmentBaseChannel, type SegmentChannel } from "../../slots.js";
import { fitsUnsigned, type ValueId, type ValueTable } from "../../values.js";
import type { StateCells } from "./cells.js";
import type { StateAccess } from "./access.js";

export type SegmentMode = "flat32";

export type SegmentReadOptions = Readonly<{
  signed?: boolean;
}>;

export type SegmentTerminator = (finish: Finish, actions: readonly Action[]) => void;

export class SegmentState {
  readonly #values: ValueTable;
  readonly #cells: StateCells;
  readonly #state: StateAccess;
  readonly #mode: SegmentMode;
  readonly #terminate: SegmentTerminator;
  readonly #faultFlushes: () => readonly Action[];
  readonly #dynamicBases = new Map<number, ValueId>();

  constructor(
    values: ValueTable,
    cells: StateCells,
    state: StateAccess,
    mode: SegmentMode,
    terminate: SegmentTerminator,
    faultFlushes: () => readonly Action[]
  ) {
    this.#values = values;
    this.#cells = cells;
    this.#state = state;
    this.#mode = mode;
    this.#terminate = terminate;
    this.#faultFlushes = faultFlushes;
  }

  beginInstruction(): void {
    this.#dynamicBases.clear();
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
      this.#state.read({ kind: "segmentDynamic", index, field: "selector" }, fitsUnsigned(16)),
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
      base = this.#state.read({ kind: "segmentDynamic", index, field: "base" });
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
          this.#faultFlushes()
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
