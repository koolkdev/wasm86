import type {
  BlockActionSite,
  BlockDefinitionSite,
  BlockTimelineSite
} from "#ir/block/timeline.js";
import {
  definitionExpr,
  type BlockDefinitionId
} from "#ir/block/definitions.js";
import type { StateTarget } from "#ir/block/state/targets.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";
import type { ExprRef } from "#ir/expr/types.js";
import {
  compareProgramPoints,
  type ProgramPoint,
  type TimelineGeometry
} from "./geometry/index.js";

export type BarrierFacts = Readonly<{
  barriers: readonly Barrier[];
  definitions: readonly DefinitionResult[];
}>;

export type Barrier =
  | Readonly<{
      kind: "memory-write";
      site: BlockActionSite;
      inputPoint: ProgramPoint;
      effectPoint: ProgramPoint;
    }>
  | Readonly<{
      kind: "dynamic-register-store";
      site: BlockActionSite;
      inputPoint: ProgramPoint;
      effectPoint: ProgramPoint;
    }>;

export type DefinitionResult = Readonly<{
  id: BlockDefinitionId;
  site: BlockDefinitionSite;
  result: ExprRef;
  domain: "memory" | "registers";
  inputExpr: ExprRef;
  point: ProgramPoint;
}>;

export type BarrierFactsInput = Readonly<{
  walked: Pick<WalkedBlock, "timeline">;
  geometry: TimelineGeometry;
}>;

export function analyzeBarrierFacts(input: BarrierFactsInput): BarrierFacts {
  return new BarrierFactAnalyzer(input).analyze();
}

export function blockingBarrierForDefinitionReplay(
  facts: BarrierFacts,
  definition: DefinitionResult,
  use: ProgramPoint
): Barrier | undefined {
  return blockingBarrierBetween(
    facts,
    definition.point,
    use,
    (barrier) => barrierBlocksDefinition(barrier, definition)
  );
}

export function latestBlockingBarrierBeforeStateWrite(
  facts: BarrierFacts,
  target: StateTarget,
  point: ProgramPoint
): Barrier | undefined {
  return latestBlockingBarrierBefore(
    facts,
    point,
    (barrier) => barrierBlocksStateWrite(barrier, target)
  );
}

class BarrierFactAnalyzer {
  readonly #walked: Pick<WalkedBlock, "timeline">;
  readonly #geometry: TimelineGeometry;
  readonly #barriers: Barrier[] = [];
  readonly #definitions: DefinitionResult[] = [];

  constructor(input: BarrierFactsInput) {
    this.#walked = input.walked;
    this.#geometry = input.geometry;
  }

  analyze(): BarrierFacts {
    for (const site of this.#walked.timeline) {
      switch (site.kind) {
        case "definition":
          this.#collectDefinition(site);
          break;
        case "action":
          this.#collectBarrier(site);
          break;
      }
    }

    return Object.freeze({
      barriers: Object.freeze([...this.#barriers]),
      definitions: Object.freeze([...this.#definitions])
    });
  }

  #collectBarrier(site: BlockActionSite): void {
    const points = this.#sitePoints(site);

    switch (site.action.kind) {
      case "memoryStore":
        this.#barriers.push(Object.freeze({
          kind: "memory-write",
          site,
          inputPoint: points.at,
          effectPoint: points.after
        } satisfies Barrier));
        break;
      case "dynamicRegisterStore":
        this.#barriers.push(Object.freeze({
          kind: "dynamic-register-store",
          site,
          inputPoint: points.at,
          effectPoint: points.after
        } satisfies Barrier));
        break;
      case "memoryGuard":
      case "jump":
      case "branch":
      case "hostTrap":
      case "fallthrough":
        break;
    }
  }

  #collectDefinition(site: BlockDefinitionSite): void {
    const definitionPoint = this.#geometry.definitions.byDefinition.get(site.definition.id);

    if (definitionPoint === undefined) {
      throw new Error(`timeline geometry is missing definition point ${site.definition.id}`);
    }

    if (definitionPoint.site !== site) {
      throw new Error(`timeline geometry definition point ${site.definition.id} is attached to the wrong site`);
    }

    switch (site.definition.kind) {
      case "memoryLoad":
        this.#definitions.push(Object.freeze({
          id: site.definition.id,
          site,
          result: definitionExpr(site.definition.result),
          domain: "memory",
          inputExpr: site.definition.address,
          point: definitionPoint.point
        } satisfies DefinitionResult));
        break;
      case "dynamicRegisterLoad":
        this.#definitions.push(Object.freeze({
          id: site.definition.id,
          site,
          result: definitionExpr(site.definition.result),
          domain: "registers",
          inputExpr: site.definition.index,
          point: definitionPoint.point
        } satisfies DefinitionResult));
        break;
    }
  }

  #sitePoints(site: BlockTimelineSite): Readonly<{
    at: ProgramPoint;
    after: ProgramPoint;
  }> {
    const points = this.#geometry.points.bySite.get(site);

    if (points === undefined) {
      throw new Error("timeline geometry is missing points for a walked timeline site");
    }

    return points;
  }
}

function blockingBarrierBetween(
  facts: BarrierFacts,
  from: ProgramPoint,
  to: ProgramPoint,
  predicate: (barrier: Barrier) => boolean
): Barrier | undefined {
  return facts.barriers.find((barrier) =>
    compareProgramPoints(from, barrier.effectPoint) < 0 &&
    compareProgramPoints(barrier.effectPoint, to) < 0 &&
    predicate(barrier)
  );
}

function latestBlockingBarrierBefore(
  facts: BarrierFacts,
  point: ProgramPoint,
  predicate: (barrier: Barrier) => boolean
): Barrier | undefined {
  let latest: Barrier | undefined;

  for (const barrier of facts.barriers) {
    if (
      compareProgramPoints(barrier.effectPoint, point) < 0 &&
      predicate(barrier) &&
      (
        latest === undefined ||
        compareProgramPoints(latest.effectPoint, barrier.effectPoint) < 0
      )
    ) {
      latest = barrier;
    }
  }

  return latest;
}

function barrierBlocksDefinition(barrier: Barrier, definition: DefinitionResult): boolean {
  switch (definition.domain) {
    case "memory":
      return barrier.kind === "memory-write";
    case "registers":
      return barrier.kind === "dynamic-register-store";
  }
}

function barrierBlocksStateWrite(barrier: Barrier, target: StateTarget): boolean {
  switch (target.kind) {
    case "reg":
      return barrier.kind === "dynamic-register-store";
    case "flag":
      return false;
  }
}
