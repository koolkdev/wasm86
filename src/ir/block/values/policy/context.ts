import type { BlockDefinitionId } from "#ir/block/definitions.js";
import {
  comparePlacement,
  type BlockTimelineSite
} from "#ir/block/timeline.js";
import type { ExprRef } from "#ir/expr/types.js";
import {
  producedValueForDefinitionSite,
  type ProducedValue
} from "../plan/produced.js";
import {
  buildConstraintIndex,
  type ConstraintIndex
} from "./constraint-index.js";
import {
  definitionSiteForConstraints,
  type TimelineConstraints
} from "./constraints.js";
import {
  buildValueIdentity,
  type ValueIdentity
} from "./identity.js";
import type { ValueRoot } from "../plan/roots.js";

const valuePolicyContextBrand: unique symbol = Symbol("ValuePolicyContext");

export type ValuePolicyContext = Readonly<{
  readonly [valuePolicyContextBrand]: "ValuePolicyContext";
}>;

export type ValuePolicyContextState = Readonly<{
  constraints: TimelineConstraints;
  constraintIndex: ConstraintIndex;
  identity: ValueIdentity;
  producedValuesByDefinition: ReadonlyMap<BlockDefinitionId, ProducedValue>;
}>;

const contextStates = new WeakMap<ValuePolicyContext, ValuePolicyContextState>();

export type ValuePolicyContextInput = Readonly<{
  constraints: TimelineConstraints;
  timeline?: readonly BlockTimelineSite[];
  valueRoots?: readonly ValueRoot[];
  producedValues?: readonly ProducedValue[];
  /** Expressions that may be used as materialization candidate values. Missing entries are planner bugs. */
  materializationValues: readonly ExprRef[];
}>;

export function buildValuePolicyContext(input: ValuePolicyContextInput): ValuePolicyContext {
  const producedValues = validateProducedValues(
    input.constraints,
    input.producedValues ?? Object.freeze([])
  );
  const context = Object.freeze({
    [valuePolicyContextBrand]: "ValuePolicyContext"
  }) as ValuePolicyContext;

  contextStates.set(context, Object.freeze({
    constraints: input.constraints,
    constraintIndex: buildConstraintIndex(input.constraints),
    identity: buildValueIdentity({
      ...input,
      producedValues
    }),
    producedValuesByDefinition: indexProducedValues(producedValues)
  } satisfies ValuePolicyContextState));

  return context;
}

export function valuePolicyContextState(context: ValuePolicyContext): ValuePolicyContextState {
  const state = contextStates.get(context);

  if (state === undefined) {
    throw new Error("invalid value policy context");
  }

  return state;
}

export function producedValueForDefinition(
  context: ValuePolicyContextState,
  definition: BlockDefinitionId
): ProducedValue {
  const produced = context.producedValuesByDefinition.get(definition);

  if (produced !== undefined) {
    return produced;
  }

  const site = definitionSiteForConstraints(context.constraints, definition);

  if (site === undefined) {
    throw new Error(`definition ${definition} is not present in timeline constraints`);
  }

  return producedValueForDefinitionSite(site);
}

function validateProducedValues(
  constraints: TimelineConstraints,
  producedValues: readonly ProducedValue[]
): readonly ProducedValue[] {
  for (const produced of producedValues) {
    validateProducedValue(constraints, produced);
  }

  return Object.freeze([...producedValues]);
}

function validateProducedValue(
  constraints: TimelineConstraints,
  produced: ProducedValue
): void {
  const site = definitionSiteForConstraints(constraints, produced.id);

  if (site === undefined || site !== produced.site) {
    throw new Error(`produced value ${produced.id} does not match timeline constraint definition site`);
  }

  const expected = producedValueForDefinitionSite(site);

  if (
    comparePlacement(produced.at, expected.at) !== 0 ||
    produced.access.barrierDomain !== expected.access.barrierDomain ||
    produced.access.input !== expected.access.input
  ) {
    throw new Error(`produced value ${produced.id} does not match its definition site`);
  }
}

function indexProducedValues(
  producedValues: readonly ProducedValue[]
): ReadonlyMap<BlockDefinitionId, ProducedValue> {
  const producedValuesByDefinition = new Map<BlockDefinitionId, ProducedValue>();

  for (const produced of producedValues) {
    producedValuesByDefinition.set(produced.id, produced);
  }

  return new Map(producedValuesByDefinition);
}
