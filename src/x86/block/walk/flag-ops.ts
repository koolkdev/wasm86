import type { ExprRef } from "#x86/expr/types.js";
import type { FlagName } from "#x86/ir/model/flags.js";
import type {
  ConditionCode,
  IrFlagWriteCell,
  IrFlagWriteOp,
  ValueRef
} from "#x86/ir/model/types.js";
import type {
  FlagCell,
  FlagState,
  FlagWrite
} from "../state/flag-state.js";

export class FlagWalkOps {
  readonly #value: (value: ValueRef) => ExprRef;
  readonly #opIndex: () => number;
  #flags: FlagState;

  constructor(input: Readonly<{
    flags: FlagState;
    value: (value: ValueRef) => ExprRef;
    opIndex: () => number;
  }>) {
    this.#flags = input.flags;
    this.#value = input.value;
    this.#opIndex = input.opIndex;
  }

  get state(): FlagState {
    return this.#flags;
  }

  write(op: IrFlagWriteOp): void {
    this.#flags = this.#flags.apply(this.#flagWrite(op));
  }

  condition(cc: ConditionCode): ExprRef {
    const condition = this.#flags.condition(cc);

    if (condition === undefined) {
      throw new Error(`condition ${cc} depends on undefined flags at op ${this.#opIndex()}`);
    }

    return condition;
  }

  #flagWrite(op: IrFlagWriteOp): FlagWrite {
    const cells: FlagWrite["cells"] = {};

    for (const [flag, cell] of Object.entries(op.cells) as [FlagName, IrFlagWriteCell | undefined][]) {
      if (cell === undefined) {
        continue;
      }

      cells[flag] = this.#flagCell(cell);
    }

    const conditions = this.#flagConditions(op.conditions);

    return conditions === undefined
      ? { cells }
      : { cells, conditions };
  }

  #flagCell(cell: IrFlagWriteCell): FlagCell {
    switch (cell.kind) {
      case "expr":
        return Object.freeze({ kind: "expr", value: this.#value(cell.value) });
      case "undef":
        return Object.freeze({ kind: "undef" });
    }
  }

  #flagConditions(
    conditions: IrFlagWriteOp["conditions"]
  ): Partial<Record<ConditionCode, ExprRef>> | undefined {
    if (conditions === undefined) {
      return undefined;
    }

    const resolved: Partial<Record<ConditionCode, ExprRef>> = {};

    for (const [cc, value] of Object.entries(conditions) as [ConditionCode, ValueRef | undefined][]) {
      if (value !== undefined) {
        resolved[cc] = this.#value(value);
      }
    }

    return resolved;
  }
}
