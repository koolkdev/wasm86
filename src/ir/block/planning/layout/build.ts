import type { BlockExit } from "#ir/block/exits.js";
import type { BlockActionSite, BlockDefinitionSite } from "#ir/block/timeline.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";
import type {
  ExprNeedId
} from "../expression-needs.js";
import {
  compareProgramPoints,
  type Path,
  type ProgramPoint,
  type TimelineGeometry
} from "../geometry/index.js";
import type { PlacementPlan } from "../placement-analysis.js";
import type {
  PlannedStateWrite,
  StateWriteId,
  StateWritePlan
} from "../state-writes.js";
import type {
  ExprRecipe,
  ValueSnapshot,
  ValueSnapshotId,
  ValuePlan
} from "../values/index.js";
import {
  type TimelineValueUseIndex,
  type TimelineValueUse
} from "../timeline/value-uses.js";

export type LayoutRegionId = number & { readonly __layoutRegionId: unique symbol };
export type LayoutValueUseId = number & { readonly __layoutValueUseId: unique symbol };

export type BlockLayout = Readonly<{
  regions: readonly LayoutRegion[];
}>;

export type LayoutRegion = Readonly<{
  id: LayoutRegionId;
  path: Path;
  steps: readonly LayoutStep[];
}>;

export type LayoutExprUse = Readonly<{
  id: LayoutValueUseId;
  recipe: ExprRecipe;
}>;

export type LayoutTimelineInput = Readonly<{
  id: LayoutValueUseId;
  use: TimelineValueUse;
  recipe: ExprRecipe;
}>;

export type LayoutStep =
  | Readonly<{ kind: "definition"; site: BlockDefinitionSite; inputs: readonly LayoutTimelineInput[] }>
  | Readonly<{ kind: "action"; site: BlockActionSite; inputs: readonly LayoutTimelineInput[] }>
  | Readonly<{ kind: "establish-snapshot"; snapshot: ValueSnapshotId; recipe: ExprRecipe }>
  | Readonly<{
      kind: "write-state";
      emit: StateWriteId;
      satisfies: readonly StateWriteId[];
      value?: LayoutExprUse;
    }>
  | Readonly<{ kind: "exit"; exit: BlockExit }>;

export type BlockLayoutInput = Readonly<{
  walked: Pick<WalkedBlock, "timeline">;
  geometry: TimelineGeometry;
  timelineUses: TimelineValueUseIndex;
  timelineNeedByUse: ReadonlyMap<TimelineValueUse["id"], ExprNeedId>;
  values: ValuePlan;
  stateWrites: StateWritePlan;
  placement: PlacementPlan;
}>;

type LayoutEvent = Readonly<{
  point: ProgramPoint;
  tier: number;
  sequence: number;
  step: LayoutStep;
}>;

const ESTABLISH_SNAPSHOT_TIER = 0;
const WRITE_TIER = 1;
const SEMANTIC_TIER = 2;

export function buildBlockLayout(input: BlockLayoutInput): BlockLayout {
  return new BlockLayoutBuilder(input).build();
}

class BlockLayoutBuilder {
  readonly #input: BlockLayoutInput;
  readonly #snapshotById: ReadonlyMap<ValueSnapshotId, ValueSnapshot>;
  readonly #writeById: ReadonlyMap<StateWriteId, PlannedStateWrite>;
  readonly #eventsByPath = new Map<Path, LayoutEvent[]>();
  #nextRegionId = 0;
  #nextUseId = 0;
  #sequence = 0;

  constructor(input: BlockLayoutInput) {
    this.#input = input;
    this.#snapshotById = indexBy(input.values.snapshots, (snapshot) => snapshot.id);
    this.#writeById = indexBy(input.stateWrites.writes, (write) => write.id);
  }

  build(): BlockLayout {
    this.#addPlacementSteps();
    this.#addSemanticSteps();

    return Object.freeze({
      regions: Object.freeze(this.#regions())
    } satisfies BlockLayout);
  }

  #addPlacementSteps(): void {
    for (const placed of this.#input.placement.snapshots) {
      const snapshot = this.#snapshotById.get(placed.snapshot) ??
        fail(`layout references missing snapshot expression ${placed.snapshot}`);

      this.#addEvent(placed.point, ESTABLISH_SNAPSHOT_TIER, Object.freeze({
        kind: "establish-snapshot",
        snapshot: snapshot.id,
        recipe: snapshot.recipe
      } satisfies LayoutStep));
    }

    for (const placed of this.#input.placement.stateWrites) {
      const write = this.#writeById.get(placed.representativeWrite) ??
        fail(`layout references missing state write ${placed.representativeWrite}`);
      const satisfiedWrites = Object.freeze(placed.covers.map((writeId) => {
        if (!this.#writeById.has(writeId)) {
          fail(`layout references missing covered state write ${writeId}`);
        }

        return writeId;
      }));
      const value = write.value === undefined
        ? undefined
        : this.#exprUse(write.value);

      this.#addEvent(placed.point, WRITE_TIER, writeStateStep(placed.representativeWrite, satisfiedWrites, value));
    }
  }

  #addSemanticSteps(): void {
    for (const site of this.#input.walked.timeline) {
      const point = this.#sitePoint(site);

      this.#addEvent(point, SEMANTIC_TIER, site.kind === "definition"
        ? Object.freeze({
          kind: "definition",
          site,
          inputs: Object.freeze(this.#definitionInputs(site))
        } satisfies LayoutStep)
        : Object.freeze({
          kind: "action",
          site,
          inputs: Object.freeze(this.#actionInputs(site))
        } satisfies LayoutStep));
    }
  }

  #definitionInputs(site: BlockDefinitionSite): readonly LayoutTimelineInput[] {
    return this.#timelineUsesForSite(site)
      .map((use) => this.#timelineInput(use));
  }

  #actionInputs(site: BlockActionSite): readonly LayoutTimelineInput[] {
    return this.#timelineUsesForSite(site)
      .map((use) => this.#timelineInput(use));
  }

  #timelineInput(use: TimelineValueUse): LayoutTimelineInput {
    const need = this.#input.timelineNeedByUse.get(use.id) ??
      fail(`layout is missing a planned value need for ${use.kind}/${use.role}`);
    const exprUse = this.#exprUse(this.#recipeForNeed(need));

    return Object.freeze({
      id: exprUse.id,
      use,
      recipe: exprUse.recipe
    } satisfies LayoutTimelineInput);
  }

  #exprUse(recipe: ExprRecipe): LayoutExprUse {
    const id = this.#nextUseId as LayoutValueUseId;

    this.#nextUseId += 1;
    return Object.freeze({ id, recipe } satisfies LayoutExprUse);
  }

  #recipeForNeed(need: ExprNeedId): ExprRecipe {
    return this.#input.values.recipes.recipeForNeed(need) ??
      fail(`layout references expression need ${need} without a value recipe`);
  }

  #regions(): readonly LayoutRegion[] {
    const regions = [
      this.#region(this.#input.geometry.paths.root, this.#stepsFor(this.#input.geometry.paths.root))
    ];

    for (const exitPoint of this.#input.geometry.exits.points) {
      const steps = this.#stepsFor(exitPoint.path);

      if (exitPoint.path.kind !== "edge") {
        throw new Error("block exit path must be an edge layout path");
      }

      regions.push(this.#region(exitPoint.path, [...steps, exitStep(exitPoint.exit)]));
    }

    return Object.freeze(regions);
  }

  #region(path: Path, steps: readonly LayoutStep[]): LayoutRegion {
    const id = this.#nextRegionId as LayoutRegionId;

    this.#nextRegionId += 1;
    return Object.freeze({ id, path, steps: Object.freeze([...steps]) } satisfies LayoutRegion);
  }

  #addEvent(point: ProgramPoint, tier: number, step: LayoutStep): void {
    const events = this.#eventsByPath.get(point.path) ?? [];

    events.push(Object.freeze({
      point,
      tier,
      sequence: this.#sequence,
      step
    } satisfies LayoutEvent));
    this.#sequence += 1;
    this.#eventsByPath.set(point.path, events);
  }

  #stepsFor(path: Path): readonly LayoutStep[] {
    return [...(this.#eventsByPath.get(path) ?? [])]
      .sort(compareLayoutEvents)
      .map((event) => event.step);
  }

  #sitePoint(site: BlockDefinitionSite | BlockActionSite): ProgramPoint {
    return this.#input.geometry.points.bySite.get(site)?.at ??
      fail("layout references missing timeline site points");
  }

  #timelineUsesForSite(site: BlockDefinitionSite | BlockActionSite): readonly TimelineValueUse[] {
    return this.#input.timelineUses.bySite.get(site) ??
      fail("layout references missing timeline value uses for site");
  }
}

function writeStateStep(
  emit: StateWriteId,
  satisfiedWrites: readonly StateWriteId[],
  value: LayoutExprUse | undefined
): LayoutStep {
  return value === undefined
    ? Object.freeze({
      kind: "write-state",
      emit,
      satisfies: satisfiedWrites
    } satisfies LayoutStep)
    : Object.freeze({
      kind: "write-state",
      emit,
      satisfies: satisfiedWrites,
      value
    } satisfies LayoutStep);
}

function exitStep(exit: BlockExit): LayoutStep {
  return Object.freeze({ kind: "exit", exit } satisfies LayoutStep);
}

function compareLayoutEvents(left: LayoutEvent, right: LayoutEvent): number {
  const pointOrder = compareProgramPoints(left.point, right.point);

  if (pointOrder !== 0) {
    return pointOrder;
  }

  const tierOrder = left.tier - right.tier;

  return tierOrder === 0
    ? left.sequence - right.sequence
    : tierOrder;
}

function indexBy<TValue, TKey>(
  values: readonly TValue[],
  key: (value: TValue) => TKey
): ReadonlyMap<TKey, TValue> {
  return Object.freeze(new Map(values.map((value) => [key(value), value])));
}

function fail(message: string): never {
  throw new Error(message);
}
