import { assert } from "#common/assert.js";
import { resolveFlag } from "./resolve-flag.js";
import {
  memoryCheck,
  memoryRead,
  memoryResolve,
  memoryWrite
} from "./memory.js";
import { stateRead, stateWrite } from "./state.js";
import { varRead, varWrite } from "./variables.js";
import type { ValueInput } from "#compiler/ir/values/types.js";
import type {
  DeclaredOperationInputs,
  OperationEmitTarget
} from "./definition.js";
import type { OperationValueEmitter } from "./definition.js";

export type OperationWithResult =
  | ReturnType<typeof stateRead.create>
  | ReturnType<typeof memoryRead.create>
  | ReturnType<typeof memoryCheck.create>
  | ReturnType<typeof memoryResolve.create>
  | ReturnType<typeof resolveFlag.create>
  | ReturnType<typeof varRead.create>;

export type OperationWithoutResult =
  | ReturnType<typeof stateWrite.create>
  | ReturnType<typeof memoryWrite.create>
  | ReturnType<typeof varWrite.create>;

export type Operation = OperationWithResult | OperationWithoutResult;

export function emitOperation(
  target: OperationEmitTarget,
  values: OperationValueEmitter,
  operation: Operation
): void {
  const declared = operation.inputs;
  const consumed = new Set<number>();

  function consume(index: number): ValueInput {
    const input = declared[index];
    assert(input !== undefined, `unknown operation input ${index}`);
    assert(!consumed.has(index), `operation input ${index} is consumed more than once`);
    consumed.add(index);
    return input;
  }

  const inputs: DeclaredOperationInputs = {
    use(index) {
      values.emitUse(consume(index).value);
    },
    withBorrowedUse(index, callback) {
      values.withBorrowedUse(consume(index).value, callback);
    },
    takeConstant(index) {
      const input = declared[index];
      assert(input !== undefined, `unknown operation input ${index}`);
      assert(!consumed.has(index), `operation input ${index} is consumed more than once`);
      const value = values.constValue(input.value);
      if (value !== undefined) {
        consumed.add(index);
      }
      return value;
    }
  };

  switch (operation.kind) {
    case stateRead.kind:
      stateRead.emit(operation, target, inputs);
      break;
    case stateWrite.kind:
      stateWrite.emit(operation, target, inputs);
      break;
    case memoryRead.kind:
      memoryRead.emit(operation, target, inputs);
      break;
    case memoryWrite.kind:
      memoryWrite.emit(operation, target, inputs);
      break;
    case memoryCheck.kind:
      memoryCheck.emit(operation, target, inputs);
      break;
    case memoryResolve.kind:
      memoryResolve.emit(operation, target, inputs);
      break;
    case resolveFlag.kind:
      resolveFlag.emit(operation, target, inputs);
      break;
    case varRead.kind:
      varRead.emit(operation, target, inputs);
      break;
    case varWrite.kind:
      varWrite.emit(operation, target, inputs);
      break;
    default: {
      const unhandled: never = operation;
      assert(false, `unhandled IR operation ${String(unhandled)}`);
    }
  }

  for (const index of declared.keys()) {
    assert(consumed.has(index), `operation input ${index} was not consumed`);
  }
}
