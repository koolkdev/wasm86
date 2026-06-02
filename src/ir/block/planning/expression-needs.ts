import type { BlockExit } from "#ir/block/exits.js";
import type {
  BlockActionSite,
  BlockDefinitionSite,
  BlockTimelineSite
} from "#ir/block/timeline.js";
import type { WalkedBlock } from "#ir/block/walk/types.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  ExitPoint,
  ProgramPoint,
  TimelineGeometry
} from "./geometry/index.js";
import type {
  StateObligationId,
  StateObligations
} from "./state-obligations.js";

export type ExprNeedId = number & { readonly __exprNeedId: unique symbol };

export type ExprNeeds = Readonly<{
  needs: readonly ExprNeed[];
  valueNeedByObligation: ReadonlyMap<StateObligationId, ExprNeedId>;
}>;

export type ExprNeed = Readonly<{
  id: ExprNeedId;
  expr: ExprRef;
  point: ProgramPoint;
  origin: ExprNeedOrigin;
}>;

export type ExprNeedOrigin =
  | Readonly<{ kind: "action-input" }>
  | Readonly<{ kind: "definition-input" }>
  | Readonly<{ kind: "exit-payload" }>
  | Readonly<{
      kind: "state-obligation-value";
      obligation: StateObligationId;
    }>;

export type ExpressionNeedsInput = Readonly<{
  walked: Pick<WalkedBlock, "timeline">;
  geometry: TimelineGeometry;
  obligations: StateObligations;
}>;

class ExprNeedIds {
  #next = 0;

  next(): ExprNeedId {
    const id = this.#next;

    this.#next += 1;
    return id as ExprNeedId;
  }
}

export function analyzeExpressionNeeds(input: ExpressionNeedsInput): ExprNeeds {
  return new ExpressionNeedAnalyzer(input).analyze();
}

class ExpressionNeedAnalyzer {
  readonly #walked: Pick<WalkedBlock, "timeline">;
  readonly #geometry: TimelineGeometry;
  readonly #obligations: StateObligations;
  readonly #ids = new ExprNeedIds();
  readonly #needs: ExprNeed[] = [];
  readonly #valueNeedByObligation = new Map<StateObligationId, ExprNeedId>();

  constructor(input: ExpressionNeedsInput) {
    this.#walked = input.walked;
    this.#geometry = input.geometry;
    this.#obligations = input.obligations;
  }

  analyze(): ExprNeeds {
    for (const site of this.#walked.timeline) {
      switch (site.kind) {
        case "definition":
          this.#collectDefinitionInputNeeds(site);
          break;
        case "action":
          this.#collectActionInputNeeds(site);
          this.#collectExitPayloadNeeds(site);
          break;
      }
    }

    this.#collectStateObligationNeeds();

    return Object.freeze({
      needs: Object.freeze([...this.#needs]),
      valueNeedByObligation: Object.freeze(new Map(this.#valueNeedByObligation))
    });
  }

  #collectDefinitionInputNeeds(site: BlockDefinitionSite): void {
    const point = this.#definitionPoint(site);

    switch (site.definition.kind) {
      case "memoryLoad":
        this.#addNeed(site.definition.address, point, { kind: "definition-input" });
        break;
      case "dynamicRegisterLoad":
        this.#addNeed(site.definition.index, point, { kind: "definition-input" });
        break;
    }
  }

  #collectActionInputNeeds(site: BlockActionSite): void {
    const point = this.#sitePoint(site);

    switch (site.action.kind) {
      case "memoryGuard":
        this.#addNeed(site.action.address, point, { kind: "action-input" });
        break;
      case "memoryStore":
        this.#addNeed(site.action.address, point, { kind: "action-input" });
        this.#addNeed(site.action.value, point, { kind: "action-input" });
        break;
      case "dynamicRegisterStore":
        this.#addNeed(site.action.index, point, { kind: "action-input" });
        this.#addNeed(site.action.value, point, { kind: "action-input" });
        break;
      case "branch":
        this.#addNeed(site.action.condition, point, { kind: "action-input" });
        break;
      case "jump":
      case "hostTrap":
      case "fallthrough":
        break;
    }
  }

  #collectExitPayloadNeeds(site: BlockActionSite): void {
    switch (site.action.kind) {
      case "memoryGuard": {
        const faultExit = this.#exitPoint(site.action.faultExit, site);

        this.#addPayloadNeed(site.action.faultExit.payload, faultExit.point);
        break;
      }
      case "jump":
      case "hostTrap": {
        const exitPoint = this.#exitPoint(site.action.exit, site);

        this.#addPayloadNeed(site.action.exit.payload, exitPoint.point);
        break;
      }
      case "branch": {
        const taken = this.#exitPoint(site.action.taken, site);
        const notTaken = this.#exitPoint(site.action.notTaken, site);

        this.#addPayloadNeed(site.action.taken.payload, taken.point);
        if (site.action.continuation.value !== undefined) {
          this.#addNeed(site.action.continuation.value, notTaken.point, { kind: "exit-payload" });
        }
        break;
      }
      case "fallthrough": {
        const exitPoint = this.#exitPoint(site.action.exit, site);

        if (site.action.continuation.value !== undefined) {
          this.#addNeed(site.action.continuation.value, exitPoint.point, { kind: "exit-payload" });
        }
        break;
      }
      case "memoryStore":
      case "dynamicRegisterStore":
        break;
    }
  }

  #collectStateObligationNeeds(): void {
    for (const obligation of this.#obligations.obligations) {
      if (obligation.write.value !== undefined) {
        const need = this.#addNeed(
          obligation.write.value,
          obligation.point,
          {
            kind: "state-obligation-value",
            obligation: obligation.id
          }
        );

        this.#valueNeedByObligation.set(obligation.id, need.id);
      }
    }
  }

  #addPayloadNeed(payload: BlockExit["payload"], point: ProgramPoint): void {
    switch (payload.kind) {
      case "memoryFault":
        this.#addNeed(payload.address, point, { kind: "exit-payload" });
        break;
      case "jump":
        this.#addNeed(payload.target, point, { kind: "exit-payload" });
        break;
      case "branch":
        if (payload.direction === "taken") {
          this.#addNeed(payload.target, point, { kind: "exit-payload" });
        }
        break;
      case "hostTrap":
        this.#addNeed(payload.vector, point, { kind: "exit-payload" });
        break;
      case "fallthrough":
        break;
    }
  }

  #sitePoint(site: BlockTimelineSite): ProgramPoint {
    const points = this.#geometry.points.bySite.get(site);

    if (points === undefined) {
      throw new Error("timeline geometry is missing points for a walked timeline site");
    }

    return points.at;
  }

  #definitionPoint(site: BlockDefinitionSite): ProgramPoint {
    const definitionPoint = this.#geometry.definitions.byDefinition.get(site.definition.id);

    if (definitionPoint === undefined) {
      throw new Error(`timeline geometry is missing definition point ${site.definition.id}`);
    }

    if (definitionPoint.site !== site) {
      throw new Error(`timeline geometry definition point ${site.definition.id} is attached to the wrong site`);
    }

    return definitionPoint.point;
  }

  #exitPoint(exit: BlockExit, site: BlockActionSite): ExitPoint {
    const exitPoint = this.#geometry.exits.byExit.get(exit.id);

    if (exitPoint === undefined) {
      throw new Error(`timeline geometry is missing exit point ${exit.id}`);
    }

    if (exitPoint.sourceSite !== site) {
      throw new Error(`timeline geometry exit point ${exit.id} is attached to the wrong site`);
    }

    return exitPoint;
  }

  #addNeed(expr: ExprRef, point: ProgramPoint, origin: ExprNeedOrigin): ExprNeed {
    const need = Object.freeze({
      id: this.#ids.next(),
      expr,
      point,
      origin: Object.freeze({ ...origin })
    } satisfies ExprNeed);

    this.#needs.push(need);
    return need;
  }
}
