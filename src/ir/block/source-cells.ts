import {
  regAliasContaining,
  regAliasesOverlap
} from "#ir/block/reg-aliases.js";
import type { FlagName } from "#ir/model/flags.js";
import type { RegisterAlias } from "#x86/types.js";

export type SourceCell =
  | Readonly<{ kind: "reg"; reg: RegisterAlias }>
  | Readonly<{ kind: "flag"; flag: FlagName }>;

export function sourceCellForRegisterAlias(reg: RegisterAlias): SourceCell {
  return Object.freeze({
    kind: "reg",
    reg: freezeRegisterAlias(reg)
  });
}

export function sourceCellForFlag(flag: FlagName): SourceCell {
  return Object.freeze({ kind: "flag", flag });
}

export function sourceCellsOverlap(left: SourceCell, right: SourceCell): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "flag":
      return right.kind === "flag" && left.flag === right.flag;
    case "reg":
      return right.kind === "reg" && regAliasesOverlap(left.reg, right.reg);
  }
}

export function mergeSourceCells(cells: readonly SourceCell[]): readonly SourceCell[] {
  const merged: SourceCell[] = [];

  for (const cell of cells) {
    addSourceCell(merged, cell);
  }

  return Object.freeze(merged);
}

function addSourceCell(cells: SourceCell[], cell: SourceCell): void {
  switch (cell.kind) {
    case "flag":
      if (!cells.some((existing) => existing.kind === "flag" && existing.flag === cell.flag)) {
        cells.push(sourceCellForFlag(cell.flag));
      }
      return;
    case "reg":
      addRegisterSourceCell(cells, cell.reg);
      return;
  }
}

function addRegisterSourceCell(cells: SourceCell[], reg: RegisterAlias): void {
  for (const [index, cell] of cells.entries()) {
    if (cell.kind !== "reg" || cell.reg.base !== reg.base) {
      continue;
    }

    cells[index] = sourceCellForRegisterAlias(regAliasContaining(cell.reg, reg));
    return;
  }

  cells.push(sourceCellForRegisterAlias(reg));
}

function freezeRegisterAlias(alias: RegisterAlias): RegisterAlias {
  return Object.freeze({
    name: alias.name,
    base: alias.base,
    bitOffset: alias.bitOffset,
    width: alias.width
  });
}
