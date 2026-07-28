import { callOperation } from "./call.js";
import { resourceRead, resourceWrite } from "./resource.js";
import { variableRead, variableWrite } from "./variables.js";
import type {
  DerivedOperationDescription,
  OperationDefinition,
  OperationProduction
} from "./definition.js";

export { callOperation, resourceRead, resourceWrite, variableRead, variableWrite };

export type { CallOperation, CallOperationArgs } from "./call.js";
export type {
  DerivedOperationDescription,
  OperationDefinition,
  OperationNodeBase,
  OperationOutputAllocator,
  OperationProduction,
  OperationResult
} from "./definition.js";
export type {
  ResourceOperation,
  ResourceReadOperation,
  ResourceWriteArgs,
  ResourceWriteOperation
} from "./resource.js";
export type {
  VariableReadOperation,
  VariableWriteInitialization,
  VariableWriteOperation
} from "./variables.js";

const declaredOperationDefinitions = {
  call: callOperation,
  "variable.read": variableRead,
  "variable.write": variableWrite,
  "resource.read": resourceRead,
  "resource.write": resourceWrite
} as const;

type DeclaredOperationDefinition =
  (typeof declaredOperationDefinitions)[keyof typeof declaredOperationDefinitions];

type OperationDefinitions = {
  [Definition in DeclaredOperationDefinition as Definition["kind"]]: Definition;
};

const operationDefinitions: OperationDefinitions = declaredOperationDefinitions;

type OperationKind = keyof OperationDefinitions;

type OperationsByKind = {
  [Kind in OperationKind]: ReturnType<OperationDefinitions[Kind]["create"]>;
};

export type Operation = OperationsByKind[OperationKind];

type OperationDescriptions = {
  [Kind in OperationKind]: Pick<
    OperationDefinition<unknown, OperationsByKind[Kind], readonly OperationProduction[]>,
    "describe"
  >;
};

const operationDescriptions: OperationDescriptions = operationDefinitions;

export function describeOperation(operation: Operation): DerivedOperationDescription {
  return describeOperationKind(operation.kind, operation);
}

function describeOperationKind<Kind extends OperationKind>(
  kind: Kind,
  operation: OperationsByKind[Kind]
): DerivedOperationDescription {
  return operationDescriptions[kind].describe(operation);
}
