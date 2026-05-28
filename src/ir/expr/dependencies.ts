import type { FlagName } from "#ir/model/flags.js";
import type { Reg32 } from "#x86/types.js";
import {
  bitsUse,
  childUseForExpr,
  exactUse
} from "./uses.js";
import { checkedU32Mask } from "./builders.js";
import type {
  ExprRef,
  ExprUse,
  ExprInputSource
} from "./types.js";

type ExprDefinitionId = Extract<ExprInputSource, Readonly<{ kind: "def" }>>["id"];

export type ExprDependency =
  | Readonly<{ kind: "reg"; reg: Reg32; mask: number }>
  | Readonly<{ kind: "flag"; flag: FlagName }>
  | Readonly<{ kind: "def"; id: ExprDefinitionId; use: ExprUse }>;

type ExprDependencySet = Readonly<{
  regs: Map<Reg32, number>;
  flags: Set<FlagName>;
  defs: Map<ExprDefinitionId, ExprUse[]>;
}>;

export function exprDependencies(expr: ExprRef, use: ExprUse = exactUse()): readonly ExprDependency[] {
  const deps: ExprDependencySet = {
    regs: new Map(),
    flags: new Set(),
    defs: new Map()
  };

  collectExprDependencies(expr, canonicalizeUse(use), deps);
  return dependencyList(deps);
}

function collectExprDependencies(
  expr: ExprRef,
  use: ExprUse,
  deps: ExprDependencySet
): void {
  if (use.kind === "bits" && use.mask === 0) {
    return;
  }

  switch (expr.kind) {
    case "const":
      return;
    case "input":
      addInputDependency(expr.source, use, deps);
      return;
    case "unary":
      collectExprDependencies(expr.value, childUseForExpr(expr, 0, use), deps);
      return;
    case "binary":
      collectExprDependencies(expr.left, childUseForExpr(expr, 0, use), deps);
      collectExprDependencies(expr.right, childUseForExpr(expr, 1, use), deps);
      return;
    case "select":
      collectExprDependencies(expr.condition, childUseForExpr(expr, 0, use), deps);
      collectExprDependencies(expr.whenTrue, childUseForExpr(expr, 1, use), deps);
      collectExprDependencies(expr.whenFalse, childUseForExpr(expr, 2, use), deps);
      return;
    case "project":
    case "bits":
      collectExprDependencies(expr.value, childUseForExpr(expr, 0, use), deps);
      return;
    case "insertBits":
      collectExprDependencies(expr.base, childUseForExpr(expr, 0, use), deps);
      collectExprDependencies(expr.value, childUseForExpr(expr, 1, use), deps);
      return;
    case "compare":
      collectExprDependencies(expr.left, childUseForExpr(expr, 0, use), deps);
      collectExprDependencies(expr.right, childUseForExpr(expr, 1, use), deps);
      return;
  }
}

function addInputDependency(
  source: ExprInputSource,
  use: ExprUse,
  deps: ExprDependencySet
): void {
  const mask = inputUseMask(use);

  if (mask === 0) {
    return;
  }

  switch (source.kind) {
    case "reg":
      mergeRegisterDependency(source.reg, mask, deps);
      return;
    case "flag":
      mergeFlagDependency(source.flag, deps);
      return;
    case "def":
      mergeDefinitionDependency(source.id, use, deps);
      return;
  }
}

function mergeRegisterDependency(
  reg: Reg32,
  mask: number,
  deps: ExprDependencySet
): void {
  deps.regs.set(reg, ((deps.regs.get(reg) ?? 0) | mask) >>> 0);
}

function mergeFlagDependency(flag: FlagName, deps: ExprDependencySet): void {
  deps.flags.add(flag);
}

function mergeDefinitionDependency(
  id: ExprDefinitionId,
  use: ExprUse,
  deps: ExprDependencySet
): void {
  const requested = canonicalizeUse(use);
  const existing = deps.defs.get(id) ?? [];
  const next = mergeDefinitionUses(existing, requested);

  deps.defs.set(id, next);
}

function dependencyList(deps: ExprDependencySet): readonly ExprDependency[] {
  const result: ExprDependency[] = [];

  for (const [reg, mask] of deps.regs) {
    result.push({ kind: "reg", reg, mask });
  }

  for (const flag of deps.flags) {
    result.push({ kind: "flag", flag });
  }

  for (const [id, uses] of deps.defs) {
    for (const use of uses) {
      result.push({ kind: "def", id, use });
    }
  }

  return result;
}

function mergeDefinitionUses(existing: readonly ExprUse[], requested: ExprUse): ExprUse[] {
  if (requested.kind === "bits") {
    return mergeDefinitionBitsUse(existing, requested);
  }

  if (existing.some((use) => use.kind === requested.kind)) {
    return [...existing];
  }

  return [
    ...existing.filter((use) => use.kind !== "bits"),
    requested
  ];
}

function mergeDefinitionBitsUse(
  existing: readonly ExprUse[],
  requested: Extract<ExprUse, Readonly<{ kind: "bits" }>>
): ExprUse[] {
  if (existing.some((use) => use.kind === "exact" || use.kind === "full32")) {
    return [...existing];
  }

  const mask = existing.reduce(
    (merged, use) => use.kind === "bits" ? ((merged | use.mask) >>> 0) : merged,
    requested.mask
  );

  return [
    ...existing.filter((use) => use.kind !== "bits"),
    bitsUse(mask)
  ];
}

function canonicalizeUse(use: ExprUse): ExprUse {
  return use.kind === "bits" ? bitsUse(use.mask) : use;
}

function inputUseMask(use: ExprUse): number {
  switch (use.kind) {
    case "exact":
    case "full32":
      return 0xffff_ffff;
    case "bits":
      return checkedU32Mask(use.mask, "expression use mask");
  }
}
