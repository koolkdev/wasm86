import type { WalkedBlock } from "#ir/block/walk/types.js";
import type { ExprRef } from "#ir/expr/types.js";
import type {
  ProgramPoint,
  TimelineGeometry
} from "./geometry/index.js";
import type {
  StateObligationId,
  StateObligations
} from "./state-obligations.js";
import {
  timelineValueUses,
  type TimelineValueUseOriginKind
} from "./timeline/value-uses.js";

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
  | Readonly<{ kind: TimelineValueUseOriginKind }>
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
      for (const use of timelineValueUses(site, this.#geometry)) {
        this.#addNeed(use.expr, use.point, { kind: use.originKind });
      }
    }

    this.#collectStateObligationNeeds();

    return Object.freeze({
      needs: Object.freeze([...this.#needs]),
      valueNeedByObligation: Object.freeze(new Map(this.#valueNeedByObligation))
    });
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
