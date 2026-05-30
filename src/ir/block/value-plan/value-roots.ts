import type {
  BlockRoot,
  BlockRootPurpose
} from "#ir/block/roots.js";
import type { Placement } from "#ir/block/timeline.js";
import type { ExprRef } from "#ir/expr/types.js";

export type ValueRootId = number & {
  readonly __valueRootId: unique symbol;
};

export type ValueRoot = Readonly<{
  id: ValueRootId;
  root: BlockRoot;
}>;

export type ValueRootInput = Readonly<{
  roots: readonly BlockRoot[];
}>;

export function valueRootsForRoots(input: ValueRootInput): readonly ValueRoot[] {
  const roots: ValueRoot[] = [];

  for (const root of input.roots) {
    if (boundaryRootIsPassthrough(root)) {
      continue;
    }

    roots.push(Object.freeze({
      id: valueRootId(roots.length),
      root
    }));
  }

  return Object.freeze(roots);
}

export function valueRootExpr(root: ValueRoot): ExprRef {
  return root.root.expr;
}

export function valueRootPlacement(root: ValueRoot): Placement {
  return root.root.at;
}

export function valueRootPurpose(root: ValueRoot): BlockRootPurpose {
  return root.root.purpose;
}

export function isBoundaryCellValueRoot(root: ValueRoot): boolean {
  return root.root.purpose.kind === "boundaryCell";
}

export function isDefinitionInputValueRoot(root: ValueRoot): boolean {
  return root.root.purpose.kind === "definitionInput";
}

export function isActionInputValueRoot(root: ValueRoot): boolean {
  return root.root.purpose.kind === "actionInput";
}

function boundaryRootIsPassthrough(root: BlockRoot): boolean {
  if (root.purpose.kind !== "boundaryCell") {
    return false;
  }

  if (root.site.kind !== "boundary") {
    throw new Error("boundary-cell value root must reference a boundary site");
  }

  const expr = root.expr;
  const cell = root.purpose.cell;

  if (expr.kind !== "input" || expr.source.kind !== cell.kind) {
    return false;
  }

  switch (cell.kind) {
    case "reg":
      return expr.source.kind === "reg" && expr.source.reg === cell.reg;
    case "flag":
      return expr.source.kind === "flag" && expr.source.flag === cell.flag;
  }
}

function valueRootId(value: number): ValueRootId {
  return value as ValueRootId;
}
