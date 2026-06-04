import type { BlockExit } from "#ir/block/exits.js";
import type { BlockActionSite, BlockDefinitionSite } from "#ir/block/timeline.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";
import { exprsEqual } from "#ir/expr/equality.js";
import type {
  ExprNeed,
  ExprNeeds
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
  SavedExpr,
  SavedExprId,
  ValuePlan
} from "../values/index.js";
import {
  timelineValueUses,
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
  kind: "main" | "exit" | "branch-arm";
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
  | Readonly<{ kind: "save-expr"; saved: SavedExprId; recipe: ExprRecipe }>
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
  exprNeeds: ExprNeeds;
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

const SAVE_TIER = 0;
const WRITE_TIER = 1;
const SEMANTIC_TIER = 2;

export function buildBlockLayout(input: BlockLayoutInput): BlockLayout {
  return new BlockLayoutBuilder(input).build();
}

class BlockLayoutBuilder {
  readonly #input: BlockLayoutInput;
  readonly #savedById: ReadonlyMap<SavedExprId, SavedExpr>;
  readonly #writeById: ReadonlyMap<StateWriteId, PlannedStateWrite>;
  readonly #needCursor: LayoutValueNeedCursor;
  readonly #eventsByPath = new Map<Path, LayoutEvent[]>();
  #nextRegionId = 0;
  #nextUseId = 0;
  #sequence = 0;

  constructor(input: BlockLayoutInput) {
    this.#input = input;
    this.#savedById = indexBy(input.values.savedExprs, (saved) => saved.id);
    this.#writeById = indexBy(input.stateWrites.writes, (write) => write.id);
    this.#needCursor = new LayoutValueNeedCursor(input.exprNeeds.needs);
  }

  build(): BlockLayout {
    this.#addPlacementSteps();
    this.#addSemanticSteps();

    return Object.freeze({
      regions: Object.freeze(this.#regions())
    } satisfies BlockLayout);
  }

  #addPlacementSteps(): void {
    for (const placed of this.#input.placement.saveExprs) {
      const saved = this.#savedById.get(placed.saved) ??
        fail(`layout references missing saved expression ${placed.saved}`);

      this.#addEvent(placed.point, SAVE_TIER, Object.freeze({
        kind: "save-expr",
        saved: saved.id,
        recipe: saved.recipe
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
    return timelineValueUses(site, this.#input.geometry)
      .map((use) => this.#timelineInput(use));
  }

  #actionInputs(site: BlockActionSite): readonly LayoutTimelineInput[] {
    return timelineValueUses(site, this.#input.geometry)
      .map((use) => this.#timelineInput(use));
  }

  #timelineInput(use: TimelineValueUse): LayoutTimelineInput {
    const exprUse = this.#exprUse(this.#recipeForNeed(this.#needCursor.take(use.expr, use.point, use.originKind)));

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

  #recipeForNeed(need: ExprNeed): ExprRecipe {
    return this.#input.values.recipes.recipeForNeed(need.id) ??
      fail(`layout references expression need ${need.id} without a value recipe`);
  }

  #regions(): readonly LayoutRegion[] {
    const regions = [
      this.#region(this.#input.geometry.paths.root, "main", this.#stepsFor(this.#input.geometry.paths.root))
    ];

    for (const exitPoint of this.#input.geometry.exits.points) {
      const steps = this.#stepsFor(exitPoint.path);

      switch (exitPoint.path.kind) {
        case "main":
          throw new Error("block exit path cannot be the main layout path");
        case "exit":
          regions.push(this.#region(exitPoint.path, "exit", [...steps, exitStep(exitPoint.exit)]));
          break;
        case "branch":
          if (steps.length > 0) {
            regions.push(this.#region(exitPoint.path, "branch-arm", [...steps, exitStep(exitPoint.exit)]));
          }
          break;
      }
    }

    return Object.freeze(regions);
  }

  #region(path: Path, kind: LayoutRegion["kind"], steps: readonly LayoutStep[]): LayoutRegion {
    const id = this.#nextRegionId as LayoutRegionId;

    this.#nextRegionId += 1;
    return Object.freeze({ id, path, kind, steps: Object.freeze([...steps]) } satisfies LayoutRegion);
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
}

class LayoutValueNeedCursor {
  readonly #needsByPoint = new Map<ProgramPoint, Map<ExprNeed["origin"]["kind"], readonly ExprNeed[]>>();
  readonly #used = new Set<ExprNeed["id"]>();

  constructor(needs: readonly ExprNeed[]) {
    for (const need of needs) {
      const byOrigin = this.#needsByPoint.get(need.point) ?? new Map();
      const originNeeds = byOrigin.get(need.origin.kind) ?? [];

      byOrigin.set(need.origin.kind, Object.freeze([...originNeeds, need]));
      this.#needsByPoint.set(need.point, byOrigin);
    }
  }

  take(
    expr: ExprNeed["expr"],
    point: ProgramPoint,
    originKind: ExprNeed["origin"]["kind"]
  ): ExprNeed {
    const candidates = this.#needsByPoint.get(point)?.get(originKind) ?? [];
    const need = candidates.find((candidate) =>
      !this.#used.has(candidate.id) &&
      exprsEqual(candidate.expr, expr)
    );

    if (need === undefined) {
      throw new Error(`layout is missing a planned value need for ${originKind}`);
    }

    this.#used.add(need.id);
    return need;
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
