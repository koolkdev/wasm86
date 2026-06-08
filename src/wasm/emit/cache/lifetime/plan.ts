import { assert } from "#common/assert.js";
import type { BlockEdgeId } from "#ir/block/planning/geometry/index.js";
import type {
  LayoutRegion,
  LayoutRegionId,
  LayoutStep,
  LayoutTimelineInput
} from "#ir/block/planning/layout/index.js";
import type {
  ExprRecipe,
  ValueSnapshotId
} from "#ir/block/planning/values/index.js";
import { WasmCacheEntryIndex } from "../entries.js";
import type {
  WasmCacheEntry,
  WasmCacheEntryId
} from "../plan/index.js";
import type {
  WasmCacheLifetimeBudget,
  WasmCacheLifetimePlan,
  WasmCacheLifetimePlanInput
} from "./types.js";

type MutableRegionLifetimeFacts = {
  directUses: Map<WasmCacheEntryId, number>;
  establishes: Set<WasmCacheEntryId>;
  unknownUses: Set<WasmCacheEntryId>;
};

export function planWasmCacheLifetime(input: WasmCacheLifetimePlanInput): WasmCacheLifetimePlan {
  return new WasmCacheLifetimePlanner(input).plan();
}

class WasmCacheLifetimePlanner {
  readonly #input: WasmCacheLifetimePlanInput;
  readonly #entries: WasmCacheEntryIndex;
  readonly #factsByRegion = new Map<LayoutRegionId, MutableRegionLifetimeFacts>();
  readonly #regionByEdge = new Map<BlockEdgeId, LayoutRegion>();

  constructor(input: WasmCacheLifetimePlanInput) {
    this.#input = input;
    this.#entries = new WasmCacheEntryIndex(input.cachePlan, input.values);
    this.#indexRegions();
  }

  plan(): WasmCacheLifetimePlan {
    this.#collectRegionFacts();

    return {
      budgets: this.#budgets()
    };
  }

  #indexRegions(): void {
    for (const region of this.#input.layout.regions) {
      this.#factsFor(region);

      if (region.path.kind === "edge") {
        assert(
          !this.#regionByEdge.has(region.path.edge),
          `duplicate layout edge region ${region.path.edge}`
        );

        this.#regionByEdge.set(region.path.edge, region);
      }
    }
  }

  #collectRegionFacts(): void {
    for (const region of this.#input.layout.regions) {
      for (const step of region.steps) {
        this.#collectStepFacts(region, step);
      }
    }
  }

  #collectStepFacts(region: LayoutRegion, step: LayoutStep): void {
    switch (step.kind) {
      case "action-inputs":
      case "action":
        for (const input of step.inputs) {
          this.#recordTimelineInputUse(region, input);
        }
        return;
      case "write-state":
        if (step.value !== undefined) {
          this.#recordSelectedUse(region, step.value.recipe);
        }
        return;
      case "establish-snapshot":
        this.#recordSnapshotEstablishment(region, step.snapshot, step.recipe);
        return;
      case "exit":
        return;
    }
  }

  #recordTimelineInputUse(containingRegion: LayoutRegion, input: LayoutTimelineInput): void {
    this.#recordSelectedUse(this.#useRegion(containingRegion, input), input.recipe);
  }

  #useRegion(containingRegion: LayoutRegion, input: LayoutTimelineInput): LayoutRegion {
    if (input.use.kind !== "exit-payload") {
      return containingRegion;
    }

    const edgeRegion = this.#regionByEdge.get(input.use.edge);

    assert(edgeRegion !== undefined, `layout has no region for exit payload edge ${input.use.edge}`);
    return edgeRegion;
  }

  #recordSnapshotEstablishment(region: LayoutRegion, snapshot: ValueSnapshotId, recipe: ExprRecipe): void {
    const entry = this.#entries.requireEntryForSnapshot(snapshot);

    this.#factsFor(region).establishes.add(entry.id);
    this.#recordCompositeInteraction(region, recipe);
  }

  #recordSelectedUse(region: LayoutRegion, recipe: ExprRecipe): void {
    const entry = this.#selectedEntryForRecipe(recipe);

    if (entry !== undefined) {
      const facts = this.#factsFor(region);

      facts.directUses.set(entry.id, (facts.directUses.get(entry.id) ?? 0) + 1);
    }

    this.#recordCompositeInteraction(region, recipe);
  }

  #recordCompositeInteraction(region: LayoutRegion, recipe: ExprRecipe): void {
    if (!mayEmitChildRecipes(recipe)) {
      return;
    }

    const facts = this.#factsFor(region);

    for (const entry of this.#input.cachePlan.entries) {
      facts.unknownUses.add(entry.id);
    }
  }

  #selectedEntryForRecipe(recipe: ExprRecipe): WasmCacheEntry | undefined {
    if (recipe.kind === "snapshot") {
      return this.#entries.entryForSnapshot(recipe.snapshot);
    }

    return this.#entries.entryForRecipe(recipe);
  }

  #budgets(): readonly WasmCacheLifetimeBudget[] {
    const budgets: WasmCacheLifetimeBudget[] = [];

    for (const region of this.#input.layout.regions) {
      const facts = this.#factsFor(region);

      for (const [entry, directUseCount] of facts.directUses) {
        if (facts.unknownUses.has(entry)) {
          continue;
        }

        if (this.#hasCrossRegionActivity(entry)) {
          continue;
        }

        budgets.push({
          entry,
          ownerRegion: region.id,
          remainingUses: directUseCount
        });
      }
    }

    return budgets;
  }

  #hasCrossRegionActivity(entry: WasmCacheEntryId): boolean {
    return this.#hasMainActivity(entry) && this.#hasChildActivity(entry);
  }

  #hasMainActivity(entry: WasmCacheEntryId): boolean {
    return this.#input.layout.regions.some((region) =>
      region.path.kind === "main" && this.#regionHasActivity(region, entry)
    );
  }

  #hasChildActivity(entry: WasmCacheEntryId): boolean {
    return this.#input.layout.regions.some((region) =>
      region.path.kind === "edge" && this.#regionHasActivity(region, entry)
    );
  }

  #regionHasActivity(region: LayoutRegion, entry: WasmCacheEntryId): boolean {
    const facts = this.#factsFor(region);

    return facts.directUses.has(entry) ||
      facts.establishes.has(entry) ||
      facts.unknownUses.has(entry);
  }

  #factsFor(region: LayoutRegion): MutableRegionLifetimeFacts {
    let facts = this.#factsByRegion.get(region.id);

    if (facts === undefined) {
      facts = {
        directUses: new Map(),
        establishes: new Set(),
        unknownUses: new Set()
      };
      this.#factsByRegion.set(region.id, facts);
    }

    return facts;
  }
}

function mayEmitChildRecipes(recipe: ExprRecipe): boolean {
  switch (recipe.kind) {
    case "snapshot":
      return false;
    case "definition":
      return true;
    case "expr":
      return recipe.children.length > 0;
  }
}
