import type { BlockDefinitionId } from "#ir/block/definitions.js";
import { regAliasForRange } from "#ir/block/reg-aliases.js";
import type { BlockRoot } from "#ir/block/roots.js";
import {
  mergeSourceCells,
  sourceCellForFlag,
  sourceCellForRegisterAlias,
  type SourceCell
} from "#ir/block/source-cells.js";
import type {
  ExprInputSource,
  ExprRef
} from "#ir/expr/types.js";
import type { FlagName } from "#ir/model/flags.js";
import { registerAlias } from "#x86/registers.js";
import type { RegisterAlias } from "#x86/types.js";

export type ExprDeps = Readonly<{
  sourceCells: readonly SourceCell[];
  definitionIds: readonly BlockDefinitionId[];
}>;

type ExprDepsSet = {
  sourceCells: SourceCell[];
  definitionIds: Set<BlockDefinitionId>;
};

export function exprDepsForExpr(expr: ExprRef): ExprDeps {
  const deps = createExprDepsSet();

  collectExprDeps(expr, deps);
  return exprDepsList(deps);
}

export function exprDepsForRoot(root: BlockRoot): ExprDeps {
  const deps = createExprDepsSet();
  const width = rootOutputWidth(root);

  if (width === undefined) {
    collectExprDeps(root.expr, deps);
  } else {
    collectLowBits(root.expr, width, deps);
  }

  return exprDepsList(deps);
}

function collectExprDeps(expr: ExprRef, deps: ExprDepsSet): void {
  switch (expr.kind) {
    case "const":
      return;
    case "input":
      addInputDeps(expr.source, deps);
      return;
    case "unary":
      collectUnaryDeps(expr, deps);
      return;
    case "binary":
      collectExprDeps(expr.left, deps);
      collectExprDeps(expr.right, deps);
      return;
    case "select":
      collectExprDeps(expr.condition, deps);
      collectExprDeps(expr.whenTrue, deps);
      collectExprDeps(expr.whenFalse, deps);
      return;
    case "project":
      collectLowBits(expr.value, expr.width, deps);
      return;
    case "bits":
      collectBitRange(expr.value, expr.offset, expr.width, deps);
      return;
    case "insertBits":
      collectExprDeps(expr.base, deps);
      collectLowBits(expr.value, expr.width, deps);
      return;
    case "compare":
      collectLowBits(expr.left, expr.width, deps);
      collectLowBits(expr.right, expr.width, deps);
      return;
  }
}

function collectLowBits(expr: ExprRef, width: number, deps: ExprDepsSet): void {
  collectBitRange(expr, 0, width, deps);
}

function collectBitRange(
  expr: ExprRef,
  offset: number,
  width: number,
  deps: ExprDepsSet
): void {
  if (width <= 0 || offset >= 32) {
    return;
  }

  switch (expr.kind) {
    case "const":
      return;
    case "input":
      addInputRangeDeps(expr.source, offset, Math.min(width, 32 - offset), deps);
      return;
    case "project":
      collectBitRange(
        expr.value,
        offset,
        Math.min(width, Math.max(0, expr.width - offset)),
        deps
      );
      return;
    case "bits":
      collectBitRange(
        expr.value,
        expr.offset + offset,
        Math.min(width, Math.max(0, expr.width - offset)),
        deps
      );
      return;
    case "unary":
    case "binary":
    case "select":
    case "insertBits":
    case "compare":
      collectExprDeps(expr, deps);
      return;
  }
}

function collectUnaryDeps(
  expr: Extract<ExprRef, { kind: "unary" }>,
  deps: ExprDepsSet
): void {
  switch (expr.op) {
    case "extend8_s":
      collectLowBits(expr.value, 8, deps);
      return;
    case "extend16_s":
      collectLowBits(expr.value, 16, deps);
      return;
    case "popcnt":
      collectExprDeps(expr.value, deps);
      return;
  }
}

function addInputDeps(source: ExprInputSource, deps: ExprDepsSet): void {
  switch (source.kind) {
    case "reg":
      addRegisterDeps(registerAlias(source.reg), deps);
      return;
    case "flag":
      addFlagDeps(source.flag, deps);
      return;
    case "def":
      addDefinitionDeps(source.id as BlockDefinitionId, deps);
      return;
  }
}

function addInputRangeDeps(
  source: ExprInputSource,
  offset: number,
  width: number,
  deps: ExprDepsSet
): void {
  switch (source.kind) {
    case "reg":
      addRegisterDeps(regAliasForRange(source.reg, offset, width), deps);
      return;
    case "flag":
      if (offset === 0 && width > 0) {
        addFlagDeps(source.flag, deps);
      }
      return;
    case "def":
      addDefinitionDeps(source.id as BlockDefinitionId, deps);
      return;
  }
}

function addRegisterDeps(reg: RegisterAlias, deps: ExprDepsSet): void {
  deps.sourceCells.push(sourceCellForRegisterAlias(reg));
}

function addFlagDeps(flag: FlagName, deps: ExprDepsSet): void {
  deps.sourceCells.push(sourceCellForFlag(flag));
}

function addDefinitionDeps(id: BlockDefinitionId, deps: ExprDepsSet): void {
  deps.definitionIds.add(id);
}

function rootOutputWidth(root: BlockRoot): number | undefined {
  const { site, purpose } = root;

  if (purpose.kind !== "actionInput" || purpose.input !== "value" || site.kind !== "action") {
    return undefined;
  }

  switch (site.action.kind) {
    case "memoryStore":
    case "dynamicRegisterStore":
      return site.action.width;
    case "memoryGuard":
    case "jump":
    case "branch":
    case "hostTrap":
    case "fallthrough":
      return undefined;
  }
}

function createExprDepsSet(): ExprDepsSet {
  return {
    sourceCells: [],
    definitionIds: new Set()
  };
}

function exprDepsList(deps: ExprDepsSet): ExprDeps {
  return Object.freeze({
    sourceCells: mergeSourceCells(deps.sourceCells),
    definitionIds: Object.freeze([...deps.definitionIds])
  });
}
