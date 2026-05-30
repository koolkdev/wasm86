import type {
  BlockActionSite,
  BlockBoundarySite,
  BlockTimelineSite,
  Placement
} from "#ir/block/timeline.js";
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
  at: Placement;
  source: SourceCell;
  site: BlockBoundarySite;
}>;

export type SourceBarrier = Readonly<{
  kind: "barrier";
  at: Placement;
  scope: "registers";
  site: BlockActionSite;
}>;

export type SourceEffect = SourceWrite | SourceBarrier;

export function sourceEffectsForBlockSites(input: {
  timeline: readonly BlockTimelineSite[];
}): readonly SourceEffect[] {
  const effects: SourceEffect[] = [];

  for (const site of input.timeline) {
    switch (site.kind) {
      case "boundary":
        if (site.boundary.kind === "stateSync") {
          appendStateSyncEffects(effects, site);
        }
        break;
      case "action":
        if (site.action.kind === "dynamicRegisterStore") {
          effects.push(sourceBarrier(site));
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
  site: BlockBoundarySite
): void {
  for (const cell of site.boundary.state.registers.cells()) {
    if (!registerCellIsPassthrough(cell)) {
      effects.push(sourceWrite(site, sourceCellForRegisterAlias(registerAlias(cell.reg))));
    }
  }

  for (const { flag, cell } of site.boundary.state.flags.cells()) {
    if (!flagCellIsPassthrough(flag, cell)) {
      effects.push(sourceWrite(site, sourceCellForFlag(flag)));
    }
  }
}

function sourceWrite(
  site: BlockBoundarySite,
  source: SourceCell
): SourceWrite {
  return Object.freeze({
    kind: "write",
    at: site.at,
    source,
    site
  });
}

function sourceBarrier(
  site: BlockActionSite
): SourceBarrier {
  return Object.freeze({
    kind: "barrier",
    at: site.at,
    scope: "registers",
    site
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
