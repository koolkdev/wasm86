import type { CallOperation } from "./call.js";
import type {
  VariableReadOperation,
  VariableWriteOperation
} from "./variables.js";
import type {
  ResourceReadOperation,
  ResourceWriteOperation
} from "./resource.js";

export { callOperation } from "./call.js";
export { variableRead, variableWrite } from "./variables.js";
export { resourceRead, resourceWrite } from "./resource.js";

export type {
  CallOperation,
  CallOperationArgs
} from "./call.js";
export type {
  VariableReadOperation,
  VariableWriteInitialization,
  VariableWriteOperation
} from "./variables.js";
export type {
  OperationBase,
  OperationFactory,
  OperationResult
} from "./definition.js";
export type {
  ResourceOperation,
  ResourceReadOperation,
  ResourceWriteArgs,
  ResourceWriteOperation
} from "./resource.js";

export type Operation =
  | CallOperation
  | VariableReadOperation
  | VariableWriteOperation
  | ResourceReadOperation
  | ResourceWriteOperation;
