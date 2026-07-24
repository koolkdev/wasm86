import type { StorageEffects } from "#compiler/ir/effects.js";
import {
  describeControl
} from "#compiler/ir/controls/index.js";
import {
  describeOperation,
  type DerivedOperationDescription,
  type Operation,
  type OperationResult
} from "#compiler/ir/operations/index.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type {
  ValueId,
  ValueInput
} from "#compiler/ir/values/types.js";
import type { Region, RegionNode } from "./region.js";

// A child region as seen by generic IR consumers. Loop bodies additionally
// declare the values scoped to the loop's back edge.
export type NestedRegion = Readonly<{
  body: Region;
  role: string;
  scope:
    | Readonly<{ kind: "ordinary" }>
    | Readonly<{ kind: "loop"; inputs: readonly ValueId[] }>;
}>;

export type NodeDescription = Readonly<{
  operands: readonly ValueId[];
  outputs: readonly ValueId[];
  nestedBodies: readonly NestedRegion[];
  effects: StorageEffects;
  referencedResources: readonly ResourceRef[];
}>;

export type OperationDescription = NodeDescription & Readonly<{
  inputs: readonly ValueInput[];
  results: readonly OperationResult[];
  nestedBodies: readonly [];
}>;

const noNestedBodies: readonly [] = [];
const noReferencedResources: readonly [] = [];

export function describeNode(node: Operation): OperationDescription;
export function describeNode(node: RegionNode): NodeDescription;
export function describeNode(
  node: RegionNode
): NodeDescription | OperationDescription {
  switch (node.category) {
    case "control":
      return controlDescription(describeControl(node));
    case "operation":
      return operationDescription(describeOperation(node));
  }
}

function controlDescription(
  description: ReturnType<typeof describeControl>
): NodeDescription {
  return {
    ...description,
    referencedResources: noReferencedResources
  };
}

function operationDescription(
  description: DerivedOperationDescription
): OperationDescription {
  return {
    inputs: description.inputs,
    operands: description.inputs.map((input) => input.value),
    results: description.productions.map((production) => production.result),
    outputs: description.productions.map((production) => production.output),
    nestedBodies: noNestedBodies,
    effects: description.effects,
    referencedResources:
      description.referencedResources ?? noReferencedResources
  };
}
