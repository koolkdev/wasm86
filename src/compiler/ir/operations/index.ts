import {
  callOperation
} from "./call.js";
import {
  resourceRead,
  resourceWrite
} from "./resource.js";
import {
  variableRead,
  variableWrite
} from "./variables.js";

export {
  callOperation,
  resourceRead,
  resourceWrite,
  variableRead,
  variableWrite
};

export type {
  CallOperation,
  CallOperationArgs
} from "./call.js";
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

const operationDefinitions = [
  callOperation,
  variableRead,
  variableWrite,
  resourceRead,
  resourceWrite
] as const;

type AnyOperationDefinition = (typeof operationDefinitions)[number];

export type Operation = ReturnType<AnyOperationDefinition["create"]>;
