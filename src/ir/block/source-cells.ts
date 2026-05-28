import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  regAliasContaining,
  regAliasForRange,
  regAliasesOverlap
} from "#ir/block/reg-aliases.js";
import type { BlockRoot } from "#ir/block/roots.js";
import type {
  ExprInputSource,
  ExprRef
} from "#ir/expr/types.js";
import type { FlagName } from "#ir/model/flags.js";
import { registerAlias } from "#x86/registers.js";
import type { RegisterAlias } from "#x86/types.js";

export type SourceCell =
  | Readonly<{ kind: "reg"; reg: RegisterAlias }>
  | Readonly<{ kind: "flag"; flag: FlagName }>;

export type ExprSourceCells = Readonly<{
  sources: readonly SourceCell[];
  definitions: readonly BlockDefinitionId[];
}>;

type SourceCellSet = {
  sources: SourceCell[];
  definitions: BlockDefinitionId[];
};

export function sourceCellsForRoot(root: BlockRoot): ExprSourceCells {
  const cells = createSourceCellSet();
  const width = rootOutputWidth(root);

  if (width === undefined) {
    collectExprSources(root.expr, cells);
  } else {
    collectLowBits(root.expr, width, cells);
  }

  return sourceCellList(cells);
}

export function sourceCellsForExpr(expr: ExprRef): ExprSourceCells {
  const cells = createSourceCellSet();

  collectExprSources(expr, cells);
  return sourceCellList(cells);
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

export function registerAliasesOverlap(left: RegisterAlias, right: RegisterAlias): boolean {
  return regAliasesOverlap(left, right);
}

export function sourceCellForRegisterAlias(reg: RegisterAlias): SourceCell {
  return Object.freeze({
    kind: "reg",
    reg: freezeRegisterAlias(reg)
  });
}

export function sourceCellForFlag(flag: FlagName): SourceCell {
  return Object.freeze({ kind: "flag", flag });
}

function collectExprSources(expr: ExprRef, cells: SourceCellSet): void {
  switch (expr.kind) {
    case "const":
      return;
    case "input":
      addInputSource(expr.source, cells);
      return;
    case "unary":
      collectUnarySources(expr, cells);
      return;
    case "binary":
      collectBinarySources(expr, cells);
      return;
    case "select":
      collectExprSources(expr.condition, cells);
      collectExprSources(expr.whenTrue, cells);
      collectExprSources(expr.whenFalse, cells);
      return;
    case "project":
      collectLowBits(expr.value, expr.width, cells);
      return;
    case "bits":
      collectBitRange(expr.value, expr.offset, expr.width, cells);
      return;
    case "insertBits":
      collectExprSources(expr.base, cells);
      collectLowBits(expr.value, expr.width, cells);
      return;
    case "compare":
      collectLowBits(expr.left, expr.width, cells);
      collectLowBits(expr.right, expr.width, cells);
      return;
  }
}

function collectLowBits(expr: ExprRef, width: number, cells: SourceCellSet): void {
  collectBitRange(expr, 0, width, cells);
}

function collectBitRange(
  expr: ExprRef,
  offset: number,
  width: number,
  cells: SourceCellSet
): void {
  if (width <= 0 || offset >= 32) {
    return;
  }

  switch (expr.kind) {
    case "const":
      return;
    case "input":
      addInputRangeSource(expr.source, offset, Math.min(width, 32 - offset), cells);
      return;
    case "project":
      collectBitRange(
        expr.value,
        offset,
        Math.min(width, Math.max(0, expr.width - offset)),
        cells
      );
      return;
    case "bits":
      collectBitRange(
        expr.value,
        expr.offset + offset,
        Math.min(width, Math.max(0, expr.width - offset)),
        cells
      );
      return;
    case "unary":
    case "binary":
    case "select":
    case "insertBits":
    case "compare":
      collectExprSources(expr, cells);
      return;
  }
}

function collectUnarySources(
  expr: Extract<ExprRef, { kind: "unary" }>,
  cells: SourceCellSet
): void {
  switch (expr.op) {
    case "extend8_s":
      collectLowBits(expr.value, 8, cells);
      return;
    case "extend16_s":
      collectLowBits(expr.value, 16, cells);
      return;
    case "popcnt":
      collectExprSources(expr.value, cells);
      return;
  }
}

function collectBinarySources(
  expr: Extract<ExprRef, { kind: "binary" }>,
  cells: SourceCellSet
): void {
  collectExprSources(expr.left, cells);
  collectExprSources(expr.right, cells);
}

function addInputSource(source: ExprInputSource, cells: SourceCellSet): void {
  switch (source.kind) {
    case "reg":
      addRegisterSource(registerAlias(source.reg), cells);
      return;
    case "flag":
      addFlagSource(source.flag, cells);
      return;
    case "def":
      addDefinitionSource(source.id as BlockDefinitionId, cells);
      return;
  }
}

function addInputRangeSource(
  source: ExprInputSource,
  offset: number,
  width: number,
  cells: SourceCellSet
): void {
  switch (source.kind) {
    case "reg":
      addRegisterSource(regAliasForRange(source.reg, offset, width), cells);
      return;
    case "flag":
      if (offset === 0 && width > 0) {
        addFlagSource(source.flag, cells);
      }
      return;
    case "def":
      addDefinitionSource(source.id as BlockDefinitionId, cells);
      return;
  }
}

function addRegisterSource(reg: RegisterAlias, cells: SourceCellSet): void {
  for (const [index, source] of cells.sources.entries()) {
    if (source.kind !== "reg" || source.reg.base !== reg.base) {
      continue;
    }

    cells.sources[index] = sourceCellForRegisterAlias(regAliasContaining(source.reg, reg));
    return;
  }

  cells.sources.push(sourceCellForRegisterAlias(reg));
}

function addFlagSource(flag: FlagName, cells: SourceCellSet): void {
  if (!cells.sources.some((source) => source.kind === "flag" && source.flag === flag)) {
    cells.sources.push(sourceCellForFlag(flag));
  }
}

function addDefinitionSource(id: BlockDefinitionId, cells: SourceCellSet): void {
  if (!cells.definitions.includes(id)) {
    cells.definitions.push(id);
  }
}

function rootOutputWidth(root: BlockRoot): number | undefined {
  const { entry, purpose } = root;

  if (purpose.kind === "boundaryCell" && purpose.cell.kind === "flag") {
    return 1;
  }

  if (purpose.kind !== "actionInput" || purpose.input !== "value" || entry.role !== "action") {
    return undefined;
  }

  switch (entry.action.kind) {
    case "memoryStore":
    case "dynamicRegisterStore":
      return entry.action.width;
    case "memoryGuard":
    case "jump":
    case "branch":
    case "hostTrap":
    case "fallthrough":
      return undefined;
  }
}

function createSourceCellSet(): SourceCellSet {
  return {
    sources: [],
    definitions: []
  };
}

function sourceCellList(cells: SourceCellSet): ExprSourceCells {
  return Object.freeze({
    sources: Object.freeze([...cells.sources]),
    definitions: Object.freeze([...cells.definitions])
  });
}

function freezeRegisterAlias(alias: RegisterAlias): RegisterAlias {
  return Object.freeze({
    name: alias.name,
    base: alias.base,
    bitOffset: alias.bitOffset,
    width: alias.width
  });
}
