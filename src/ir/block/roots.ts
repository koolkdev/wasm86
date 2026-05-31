import type {
  BlockTimeline,
  BlockTimelineSite,
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import type { ExprRef } from "#ir/expr/types.js";

export type BlockRootPurpose =
  | Readonly<{
      kind: "actionInput";
      input: "address" | "value" | "index" | "condition" | "target" | "vector";
      direction?: "taken" | "notTaken";
    }>
  | Readonly<{
      kind: "definitionInput";
      input: "address" | "index";
    }>;

export type BlockRoot = Readonly<{
  expr: ExprRef;
  at: Placement;
  purpose: BlockRootPurpose;
  site: BlockTimelineSite;
}>;

export type BlockRoots = readonly BlockRoot[];

export function rootsForBlockSites(input: {
  timeline: BlockTimeline;
}): BlockRoots {
  return Object.freeze(input.timeline.flatMap(rootsForTimelineSite));
}

function rootsForTimelineSite(site: BlockTimelineSite): readonly BlockRoot[] {
  switch (site.kind) {
    case "action":
      return rootsForActionSite(site);
    case "definition":
      return rootsForDefinitionSite(site);
  }
}

function rootsForActionSite(
  site: Extract<BlockTimelineSite, { kind: "action" }>
): readonly BlockRoot[] {
  switch (site.action.kind) {
    case "memoryGuard":
      return [
        root(site.action.address, site, { kind: "actionInput", input: "address" })
      ];
    case "memoryStore":
      return [
        root(site.action.address, site, { kind: "actionInput", input: "address" }),
        root(site.action.value, site, { kind: "actionInput", input: "value" })
      ];
    case "dynamicRegisterStore":
      return [
        root(site.action.index, site, { kind: "actionInput", input: "index" }),
        root(site.action.value, site, { kind: "actionInput", input: "value" })
      ];
    case "jump":
      return [
        root(site.action.target, site, { kind: "actionInput", input: "target" })
      ];
    case "branch": {
      const roots = [
        root(site.action.condition, site, { kind: "actionInput", input: "condition" }),
        root(site.action.takenTarget, site, {
          kind: "actionInput",
          input: "target",
          direction: "taken"
        })
      ];

      if (site.action.continuation.value !== undefined) {
        roots.push(root(site.action.continuation.value, site, {
          kind: "actionInput",
          input: "target",
          direction: "notTaken"
        }));
      }

      return roots;
    }
    case "hostTrap":
      return [
        root(site.action.vector, site, { kind: "actionInput", input: "vector" })
      ];
    case "fallthrough":
      return site.action.continuation.value === undefined
        ? []
        : [
            root(site.action.continuation.value, site, {
              kind: "actionInput",
              input: "target"
            })
          ];
  }
}

function rootsForDefinitionSite(site: BlockDefinitionSite): readonly BlockRoot[] {
  switch (site.definition.kind) {
    case "memoryLoad":
      return [
        root(site.definition.address, site, {
          kind: "definitionInput",
          input: "address"
        })
      ];
    case "dynamicRegisterLoad":
      return [
        root(site.definition.index, site, {
          kind: "definitionInput",
          input: "index"
        })
      ];
  }
}

function root(
  expr: ExprRef,
  site: BlockTimelineSite,
  purpose: BlockRootPurpose
): BlockRoot {
  return Object.freeze({
    expr,
    at: site.at,
    purpose: Object.freeze(purpose),
    site
  });
}
