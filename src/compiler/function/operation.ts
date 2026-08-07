import { assert } from "#common/assert.js";
import type { Invocation } from "#compiler/function/invocation.js";
import type { ResourceAccessNode } from "#compiler/function/resource.js";
import type { ValueRef } from "#compiler/function/values.js";
import type { IntegerRef } from "#compiler/function/values/reference.js";
import { Integer, type ValueType } from "#compiler/function/values/type.js";
import type { StorageEffects, VariableRef } from "#compiler/function/storage.js";

export type CallOperation = Readonly<{
  category: "operation";
  kind: "call";
  invocation: Invocation;
  output?: ValueRef;
}>;

export function callOperation(invocation: Invocation, output?: ValueRef): CallOperation {
  const results = invocation.target.type.results;

  assert(
    results.length <= 1,
    `call has ${results.length} results; multiple call results are not supported yet`
  );

  const result = results[0];
  if (result === undefined) {
    assert(output === undefined, "resultless call has an output");
    return { category: "operation", kind: "call", invocation };
  }

  assert(output !== undefined, "value-producing call has no output");
  return {
    category: "operation",
    kind: "call",
    invocation,
    output
  };
}

export type ResourceReadOperation = Readonly<{
  category: "operation";
  kind: "resource.read";
  source: ResourceAccessNode;
  output: IntegerRef;
}>;

export type ResourceWriteOperation = Readonly<{
  category: "operation";
  kind: "resource.write";
  destination: ResourceAccessNode;
  value: IntegerRef;
}>;

export type ResourceOperation = ResourceReadOperation | ResourceWriteOperation;

export function resourceRead(
  source: ResourceAccessNode,
  output: IntegerRef
): ResourceReadOperation {
  return {
    category: "operation",
    kind: "resource.read",
    source,
    output
  };
}

export function resourceWrite(
  destination: ResourceAccessNode,
  value: IntegerRef
): ResourceWriteOperation {
  return {
    category: "operation",
    kind: "resource.write",
    destination,
    value
  };
}

export type VariableReadOperation = Readonly<{
  category: "operation";
  kind: "variable.read";
  variable: VariableRef;
  output: ValueRef;
}>;

export type VariableWriteInitialization = "seed" | "update";

export type VariableWriteOperation = Readonly<{
  category: "operation";
  kind: "variable.write";
  variable: VariableRef;
  value: ValueRef;
  initialization: VariableWriteInitialization;
}>;

export function variableRead(variable: VariableRef, output: ValueRef): VariableReadOperation {
  return {
    category: "operation",
    kind: "variable.read",
    variable,
    output
  };
}

export function variableWrite(
  variable: VariableRef,
  value: ValueRef,
  initialization: VariableWriteInitialization
): VariableWriteOperation {
  return {
    category: "operation",
    kind: "variable.write",
    variable,
    value,
    initialization
  };
}

export type Operation =
  | CallOperation
  | ResourceReadOperation
  | ResourceWriteOperation
  | VariableReadOperation
  | VariableWriteOperation;

export function operationOperands(operation: Operation): readonly ValueRef[] {
  switch (operation.kind) {
    case "resource.read":
      return [operation.source.address.base];
    case "resource.write":
      return [operation.destination.address.base, operation.value];
    case "variable.read":
      return [];
    case "variable.write":
      return [operation.value];
    case "call":
      return operation.invocation.arguments;
  }
}

export function operationOutput(operation: Operation): ValueRef | undefined {
  switch (operation.kind) {
    case "resource.read":
    case "variable.read":
    case "call":
      return operation.output;
    case "resource.write":
    case "variable.write":
      return undefined;
  }
}

export function operationResultType(operation: Operation): ValueType | undefined {
  switch (operation.kind) {
    case "resource.read":
      return Integer[operation.source.valueWidth];
    case "variable.read":
      return Integer[operation.variable.width];
    case "call":
      return operation.invocation.target.type.results[0];
    case "resource.write":
    case "variable.write":
      return undefined;
  }
}

export function operationEffects(operation: Operation): StorageEffects {
  switch (operation.kind) {
    case "resource.read":
      return { reads: [operation.source.effect], writes: [] };
    case "resource.write":
      return { reads: [], writes: [operation.destination.effect] };
    case "variable.read":
      return {
        reads: [{ space: "variable", variable: operation.variable }],
        writes: []
      };
    case "variable.write":
      return {
        reads: [],
        writes: [{ space: "variable", variable: operation.variable }]
      };
    case "call":
      return operation.invocation.target.effects;
  }
}
