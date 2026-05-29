import type { BlockAction } from "#ir/block/actions.js";
import type {
  BlockSchedule,
  BlockScheduleEntry,
  Placement
} from "#ir/block/schedule.js";
import {
  sourceCellForFlag,
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import type { FlagCell } from "#ir/block/state/flag-state.js";
import type { RegisterCell } from "#ir/block/state/register-state.js";
import type { ExprRef } from "#ir/expr/types.js";
import { registerAlias } from "#x86/registers.js";

export type SourceWrite = Readonly<{
  kind: "write";
  order: number;
  at: Placement;
  source: SourceCell;
  entry: Extract<BlockScheduleEntry, { role: "boundary"; kind: "stateSync" }>;
}>;

export type SourceBarrier = Readonly<{
  kind: "barrier";
  order: number;
  at: Placement;
  scope: "registers";
  entry: DynamicRegisterStoreEntry;
}>;

export type SourceEffect = SourceWrite | SourceBarrier;

type DynamicRegisterStoreEntry = Extract<BlockScheduleEntry, { role: "action" }> & Readonly<{
  action: Extract<BlockAction, { kind: "dynamicRegisterStore" }>;
}>;

type StateSyncEntry = Extract<BlockScheduleEntry, { role: "boundary"; kind: "stateSync" }>;

export function sourceEffectsForSchedule(schedule: BlockSchedule): readonly SourceEffect[] {
  const effects: SourceEffect[] = [];

  for (const [order, entry] of schedule.entries()) {
    switch (entry.role) {
      case "boundary":
        if (entry.kind === "stateSync") {
          appendStateSyncEffects(effects, order, entry);
        }
        break;
      case "action":
        if (entry.action.kind === "dynamicRegisterStore") {
          effects.push(sourceBarrier(order, entry as DynamicRegisterStoreEntry));
        }
        break;
      case "definition":
        break;
    }
  }

  return Object.freeze(effects);
}

function appendStateSyncEffects(
  effects: SourceEffect[],
  order: number,
  entry: StateSyncEntry
): void {
  for (const cell of entry.state.registers.cells()) {
    if (!registerCellIsPassthrough(cell)) {
      effects.push(sourceWrite(order, entry, sourceCellForRegisterAlias(registerAlias(cell.reg))));
    }
  }

  for (const { flag, cell } of entry.state.flags.cells()) {
    if (!flagCellIsPassthrough(flag, cell)) {
      effects.push(sourceWrite(order, entry, sourceCellForFlag(flag)));
    }
  }
}

function sourceWrite(
  order: number,
  entry: StateSyncEntry,
  source: SourceCell
): SourceWrite {
  return Object.freeze({
    kind: "write",
    order,
    at: entry.at,
    source,
    entry
  });
}

function sourceBarrier(
  order: number,
  entry: DynamicRegisterStoreEntry
): SourceBarrier {
  return Object.freeze({
    kind: "barrier",
    order,
    at: entry.at,
    scope: "registers",
    entry
  });
}

function registerCellIsPassthrough(cell: RegisterCell): boolean {
  const value = cell.value;

  return value.kind === "input" && value.source.kind === "reg" && value.source.reg === cell.reg;
}

function flagCellIsPassthrough(
  flag: Parameters<typeof sourceCellForFlag>[0],
  cell: FlagCell
): boolean {
  switch (cell.kind) {
    case "input":
      return cell.flag === flag;
    case "expr":
      return exprIsFlagInput(cell.value, flag);
    case "undef":
      return false;
  }
}

function exprIsFlagInput(
  expr: ExprRef,
  flag: Parameters<typeof sourceCellForFlag>[0]
): boolean {
  return expr.kind === "input" && expr.source.kind === "flag" && expr.source.flag === flag;
}
