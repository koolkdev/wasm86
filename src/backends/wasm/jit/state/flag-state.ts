import { CONDITIONS, type FlagBoolExpr } from "#x86/ir/model/conditions.js";
import { IR_ALU_FLAGS } from "#x86/ir/model/flag-effects.js";
import type { FlagName } from "#x86/ir/model/flags.js";
import type { ConditionCode } from "#x86/ir/model/types.js";
import {
  exprBinary,
  exprConst,
  exprInput
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { canonicalizeExpr } from "#backends/wasm/jit/ir/expressions/canonicalize.js";
import type { ExprRef } from "#backends/wasm/jit/ir/expressions/types.js";

export type X86ConditionCode = ConditionCode;

export type FlagCell =
  | Readonly<{ kind: "expr"; value: ExprRef }>
  | Readonly<{ kind: "input"; flag: FlagName }>
  | Readonly<{ kind: "undef" }>;

export type SemanticFlagWrite = Readonly<{
  cells: Partial<Record<FlagName, FlagCell>>;
  conditions?: Partial<Record<X86ConditionCode, ExprRef>>;
}>;

export type FlagCellEntry = Readonly<{
  flag: FlagName;
  cell: FlagCell;
}>;

export class FlagState {
  readonly #cells: ReadonlyMap<FlagName, FlagCell>;
  readonly #conditions: ReadonlyMap<X86ConditionCode, ExprRef>;

  private constructor(
    cells: ReadonlyMap<FlagName, FlagCell>,
    conditions: ReadonlyMap<X86ConditionCode, ExprRef> = new Map()
  ) {
    this.#cells = cells;
    this.#conditions = conditions;
    Object.freeze(this);
  }

  static initial(): FlagState {
    const cells = new Map<FlagName, FlagCell>();

    for (const flag of IR_ALU_FLAGS) {
      cells.set(flag, flagCell(flag, { kind: "input", flag }));
    }

    return new FlagState(cells);
  }

  read(flag: FlagName): FlagCell {
    return this.#cellFor(flag);
  }

  cells(): readonly FlagCellEntry[] {
    return Object.freeze(IR_ALU_FLAGS.map((flag) => Object.freeze({ flag, cell: this.#cellFor(flag) })));
  }

  apply(write: SemanticFlagWrite): FlagState {
    const cells = new Map(this.#cells);

    for (const flag of IR_ALU_FLAGS) {
      if (!Object.hasOwn(write.cells, flag)) {
        continue;
      }

      const cell = write.cells[flag];

      if (cell === undefined) {
        throw new Error(`flag write for ${flag} must not be undefined`);
      }

      cells.set(flag, flagCell(flag, cell));
    }

    return new FlagState(cells, conditionMap(write.conditions));
  }

  condition(cc: X86ConditionCode): ExprRef | undefined {
    const direct = this.#conditions.get(cc);

    if (direct !== undefined) {
      return direct;
    }

    const semantics = CONDITIONS[cc];

    if (semantics === undefined) {
      throw new Error(`unknown x86 condition code ${cc}`);
    }

    return this.#composeCondition(semantics.expr);
  }

  #composeCondition(expr: FlagBoolExpr): ExprRef | undefined {
    switch (expr.kind) {
      case "flag":
        return this.#exprForCell(expr.flag);
      case "not": {
        const value = this.#composeCondition(expr.value);
        return value === undefined ? undefined : boolNot(value);
      }
      case "and":
      case "or":
      case "xor": {
        const left = this.#composeCondition(expr.a);
        const right = this.#composeCondition(expr.b);

        return left === undefined || right === undefined
          ? undefined
          : canonicalizeExpr(exprBinary(expr.kind, left, right));
      }
    }
  }

  #exprForCell(flag: FlagName): ExprRef | undefined {
    const cell = this.#cellFor(flag);

    switch (cell.kind) {
      case "expr":
        return cell.value;
      case "input":
        return canonicalizeExpr(exprInput({ kind: "flag", flag: cell.flag }));
      case "undef":
        return undefined;
    }
  }

  #cellFor(flag: FlagName): FlagCell {
    const cell = this.#cells.get(flag);

    if (cell === undefined) {
      throw new Error(`flag state is missing arithmetic flag cell ${flag}`);
    }

    return cell;
  }
}

function flagCell(flag: FlagName, cell: FlagCell): FlagCell {
  switch (cell.kind) {
    case "expr":
      return Object.freeze({ kind: "expr", value: canonicalizeExpr(cell.value) });
    case "input":
      if (cell.flag !== flag) {
        throw new Error(`input cell for ${flag} must reference the same flag`);
      }

      return Object.freeze({ kind: "input", flag });
    case "undef":
      return Object.freeze({ kind: "undef" });
  }
}

function conditionMap(
  conditions: Partial<Record<X86ConditionCode, ExprRef>> | undefined
): ReadonlyMap<X86ConditionCode, ExprRef> {
  const entries = new Map<X86ConditionCode, ExprRef>();

  if (conditions === undefined) {
    return entries;
  }

  for (const cc of Object.keys(CONDITIONS) as X86ConditionCode[]) {
    if (!Object.hasOwn(conditions, cc)) {
      continue;
    }

    const condition = conditions[cc];

    if (condition === undefined) {
      throw new Error(`direct condition ${cc} must not be undefined`);
    }

    entries.set(cc, canonicalizeExpr(condition));
  }

  return entries;
}

function boolNot(value: ExprRef): ExprRef {
  return canonicalizeExpr(exprBinary("xor", value, exprConst(1)));
}
