import type { StateTarget } from "#ir/block/state/targets.js";
import type { ExprNeeds } from "./expression-needs.js";
import type { ProgramPoint } from "./geometry/index.js";
import type {
  StateObligation,
  StateObligationId,
  StateObligations
} from "./state-obligations.js";
import type {
  ExprRecipe,
  ValuePlan
} from "./values/index.js";

export type StateWriteId = number & { readonly __stateWriteId: unique symbol };

export type StateWritePlan = Readonly<{
  writes: readonly PlannedStateWrite[];
}>;

export type PlannedStateWrite = Readonly<{
  id: StateWriteId;
  obligation: StateObligationId;
  point: ProgramPoint;
  target: StateTarget;
  value: ExprRecipe | undefined;
  reason: StateObligation["reason"];
}>;

export type StateWritePlanInput = Readonly<{
  obligations: StateObligations;
  needs: ExprNeeds;
  values: ValuePlan;
}>;

class StateWriteIds {
  #next = 0;

  next(): StateWriteId {
    const id = this.#next;

    this.#next += 1;
    return id as StateWriteId;
  }
}

export function analyzeStateWrites(input: StateWritePlanInput): StateWritePlan {
  return new StateWriteAnalyzer(input).analyze();
}

class StateWriteAnalyzer {
  readonly #obligations: StateObligations;
  readonly #needs: ExprNeeds;
  readonly #values: ValuePlan;
  readonly #ids = new StateWriteIds();

  constructor(input: StateWritePlanInput) {
    this.#obligations = input.obligations;
    this.#needs = input.needs;
    this.#values = input.values;
  }

  analyze(): StateWritePlan {
    return Object.freeze({
      writes: Object.freeze(this.#obligations.obligations.map((obligation) =>
        this.#plannedWrite(obligation)
      ))
    } satisfies StateWritePlan);
  }

  #plannedWrite(obligation: StateObligation): PlannedStateWrite {
    const value = obligation.write.value === undefined
      ? this.#undefinedValue(obligation)
      : this.#recipeForConcreteValue(obligation);

    return Object.freeze({
      id: this.#ids.next(),
      obligation: obligation.id,
      point: obligation.point,
      target: obligation.write.target,
      value,
      reason: obligation.reason
    } satisfies PlannedStateWrite);
  }

  #undefinedValue(obligation: StateObligation): undefined {
    if (obligation.write.target.kind === "reg") {
      throw new Error(`register state obligation ${obligation.id} has no value expression`);
    }

    return undefined;
  }

  #recipeForConcreteValue(obligation: StateObligation): ExprRecipe {
    const value = obligation.write.value;

    if (value === undefined) {
      throw new Error("concrete state write recipe requested for an undefined value");
    }

    const needId = this.#needs.valueNeedByObligation.get(obligation.id);

    if (needId === undefined) {
      throw new Error(`state obligation ${obligation.id} has no expression need for its value`);
    }

    const recipe = this.#values.recipeByNeed.get(needId);

    if (recipe === undefined) {
      throw new Error(`state obligation ${obligation.id} expression need ${needId} has no recipe`);
    }

    return recipe;
  }
}
