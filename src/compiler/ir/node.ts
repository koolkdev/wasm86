import type { StorageEffects } from "#compiler/ir/effects.js";
import {
  callOperation,
  resourceRead,
  resourceWrite,
  variableRead,
  variableWrite,
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

export type RegionCompletionContext = Readonly<{
  regionCompletes: (body: Region) => boolean;
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
      return {
        operands: node.operands,
        outputs: node.outputs,
        nestedBodies: node.nestedBodies,
        effects: node.directEffects,
        referencedResources: noReferencedResources
      };
    case "operation":
      return describeOperationNode(node);
  }
}

function describeOperationNode(node: Operation): OperationDescription {
  switch (node.kind) {
    case "call":
      return operationDescription(callOperation.describe(node));
    case "variable.read":
      return operationDescription(variableRead.describe(node));
    case "variable.write":
      return operationDescription(variableWrite.describe(node));
    case "resource.read":
      return operationDescription(resourceRead.describe(node));
    case "resource.write":
      return operationDescription(resourceWrite.describe(node));
  }
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
