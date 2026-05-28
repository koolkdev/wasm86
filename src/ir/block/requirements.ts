import {
  exprDependencies,
  type ExprDependency
} from "#ir/expr/dependencies.js";
import type { ExprGraph } from "#ir/expr/graph/index.js";
import type {
  ExprRef,
  ExprUse
} from "#ir/expr/types.js";
import {
  rootsForSchedule,
  type BlockRoot,
  type BlockRoots
} from "./roots.js";
import type {
  BlockSchedule,
  BlockScheduleEntry,
  Placement
} from "./schedule.js";

export type BlockRequirement = Readonly<{
  root: BlockRoot;
  expr: ExprRef;
  use: ExprUse;
  at: Placement;
  entry: BlockScheduleEntry;
}>;

export type BlockDefinitionDemand = Readonly<{
  requirement: BlockRequirement;
  root: BlockRoot;
  id: Extract<ExprDependency, Readonly<{ kind: "def" }>>["id"];
  use: ExprUse;
  at: Placement;
  entry: BlockScheduleEntry;
}>;

export type BlockRequirementOptions = Readonly<{
  graph?: ExprGraph;
}>;

export function requirementsForSchedule(
  schedule: BlockSchedule,
  options: BlockRequirementOptions = {}
): readonly BlockRequirement[] {
  return requirementsForRoots(rootsForSchedule(schedule), options);
}

export function requirementsForRoots(
  roots: BlockRoots,
  options: BlockRequirementOptions = {}
): readonly BlockRequirement[] {
  return Object.freeze(roots.map((root) => requirementForRoot(root, options.graph)));
}

export function definitionDemandsForRequirement(
  requirement: BlockRequirement
): readonly BlockDefinitionDemand[] {
  const demands: BlockDefinitionDemand[] = [];

  for (const dependency of exprDependencies(requirement.expr, requirement.use)) {
    if (dependency.kind !== "def") {
      continue;
    }

    demands.push(Object.freeze({
      requirement,
      root: requirement.root,
      id: dependency.id,
      use: dependency.use,
      at: requirement.at,
      entry: requirement.entry
    }));
  }

  return Object.freeze(demands);
}

export function definitionDemandsForRequirements(
  requirements: readonly BlockRequirement[]
): readonly BlockDefinitionDemand[] {
  return Object.freeze(requirements.flatMap(definitionDemandsForRequirement));
}

function requirementForRoot(root: BlockRoot, graph: ExprGraph | undefined): BlockRequirement {
  graph?.node(root.expr);

  return Object.freeze({
    root,
    expr: root.expr,
    use: root.use,
    at: root.at,
    entry: root.entry
  });
}
