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

export function isDefinitionInputValueRoot(root: ValueRoot): boolean {
  return root.root.purpose.kind === "definitionInput";
}

export function isActionInputValueRoot(root: ValueRoot): boolean {
  return root.root.purpose.kind === "actionInput";
}

function valueRootId(value: number): ValueRootId {
  return value as ValueRootId;
}
