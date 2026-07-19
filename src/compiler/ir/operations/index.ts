import type { CallOperation } from "./call.js";
import type {
  CellReadOperation,
  CellWriteOperation
} from "./cells.js";
import type {
  ResourceReadOperation,
  ResourceWriteOperation
} from "./resource.js";

export { callOperation } from "./call.js";
export { cellRead, cellWrite } from "./cells.js";
export { resourceRead, resourceWrite } from "./resource.js";

export type {
  CallOperation,
  CallOperationArgs
} from "./call.js";
export type {
  CellReadOperation,
  CellWriteInitialization,
  CellWriteOperation
} from "./cells.js";
export type {
  OperationBase,
  OperationEmitTarget,
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
  | CellReadOperation
  | CellWriteOperation
  | ResourceReadOperation
  | ResourceWriteOperation;
