import { reg32, type Reg32, type RegisterAlias } from "#x86/isa/types.js";
import {
  exprBits,
  exprInput,
  exprInsertBits,
  exprProject
} from "#backends/wasm/jit/ir/expressions/builders.js";
import { canonicalizeExpr } from "#backends/wasm/jit/ir/expressions/canonicalize.js";
import { exprsEqual } from "#backends/wasm/jit/ir/expressions/equality.js";
import type { ExprRef } from "#backends/wasm/jit/ir/expressions/types.js";

export type RegisterCell = Readonly<{
  reg: Reg32;
  value: ExprRef;
}>;

export type RegisterState = Readonly<{
  cells: ReadonlyMap<Reg32, RegisterCell>;
}>;

export function initialRegisterState(): RegisterState {
  const cells = new Map<Reg32, RegisterCell>();

  for (const reg of reg32) {
    cells.set(reg, registerCell(reg, registerInputExpr(reg)));
  }

  return Object.freeze({ cells });
}

export function registerInputExpr(reg: Reg32): ExprRef {
  return exprInput({ kind: "reg", reg });
}

export function readRegisterAlias(state: RegisterState, alias: RegisterAlias): ExprRef {
  const base = registerCellFor(state, alias.base).value;

  if (alias.width === 32) {
    return base;
  }

  return canonicalizeExpr(
    alias.bitOffset === 0
      ? exprProject(alias.width, base)
      : exprBits(base, alias.bitOffset, alias.width)
  );
}

export function writeRegisterAlias(
  state: RegisterState,
  alias: RegisterAlias,
  value: ExprRef
): RegisterState {
  const cell = registerCellFor(state, alias.base);
  const currentAliasValue = readRegisterAlias(state, alias);
  const nextAliasValue = canonicalizeExpr(value);

  if (exprsEqual(currentAliasValue, nextAliasValue)) {
    return state;
  }

  const nextBaseValue = alias.width === 32
    ? nextAliasValue
    : canonicalizeExpr(exprInsertBits(cell.value, nextAliasValue, alias.bitOffset, alias.width));
  const currentBaseValue = canonicalizeExpr(cell.value);

  if (exprsEqual(currentBaseValue, nextBaseValue)) {
    return state;
  }

  const cells = new Map(state.cells);
  cells.set(alias.base, registerCell(alias.base, nextBaseValue));

  return Object.freeze({ cells });
}

export function changedRegisterCells(state: RegisterState): readonly RegisterCell[] {
  const changed: RegisterCell[] = [];

  for (const reg of reg32) {
    const cell = registerCellFor(state, reg);

    if (!exprsEqual(canonicalizeExpr(cell.value), registerInputExpr(reg))) {
      changed.push(cell);
    }
  }

  return changed;
}

function registerCellFor(state: RegisterState, reg: Reg32): RegisterCell {
  const cell = state.cells.get(reg);

  if (cell === undefined) {
    throw new Error(`register state is missing base cell ${reg}`);
  }

  return cell;
}

function registerCell(reg: Reg32, value: ExprRef): RegisterCell {
  return Object.freeze({ reg, value: canonicalizeExpr(value) });
}
