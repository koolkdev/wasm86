import type { ExprRef } from "#ir/expr/types.js";
import type {
  ProgramPoint
} from "./geometry/index.js";
import type {
  StateObligationId,
  StateObligations
} from "./state-obligations.js";
import {
  type TimelineValueUseId,
  type TimelineValueUseIndex
} from "./timeline/value-uses.js";

export type ExprNeedId = number & { readonly __exprNeedId: unique symbol };

export type ExprNeeds = Readonly<{
  needs: readonly ExprNeed[];
  timelineNeedByUse: ReadonlyMap<TimelineValueUseId, ExprNeedId>;
  valueNeedByObligation: ReadonlyMap<StateObligationId, ExprNeedId>;
}>;

export type ExprNeed = Readonly<{
  id: ExprNeedId;
  expr: ExprRef;
  point: ProgramPoint;
  origin: ExprNeedOrigin;
}>;

export type ExprNeedOrigin =
  | Readonly<{
      kind: "timeline-use";
      use: TimelineValueUseId;
    }>
  | Readonly<{
      kind: "state-obligation-value";
      obligation: StateObligationId;
    }>;

export type ExpressionNeedsInput = Readonly<{
  timelineUses: TimelineValueUseIndex;
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
  readonly #timelineUses: TimelineValueUseIndex;
  readonly #obligations: StateObligations;
  readonly #ids = new ExprNeedIds();
  readonly #needs: ExprNeed[] = [];
  readonly #timelineNeedByUse = new Map<TimelineValueUseId, ExprNeedId>();
  readonly #valueNeedByObligation = new Map<StateObligationId, ExprNeedId>();

  constructor(input: ExpressionNeedsInput) {
    this.#timelineUses = input.timelineUses;
    this.#obligations = input.obligations;
  }

  analyze(): ExprNeeds {
    for (const use of this.#timelineUses.all) {
      const need = this.#addNeed(use.expr, use.point, {
        kind: "timeline-use",
        use: use.id
      });

      this.#timelineNeedByUse.set(use.id, need.id);
    }

    this.#collectStateObligationNeeds();

    return Object.freeze({
      needs: Object.freeze([...this.#needs]),
      timelineNeedByUse: Object.freeze(new Map(this.#timelineNeedByUse)),
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
