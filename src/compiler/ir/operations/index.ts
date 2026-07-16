import { assert } from "#common/assert.js";
import { resolveFlag } from "./resolve-flag.js";
import {
  memoryCheck,
  memoryRead,
  memoryResolve,
  memoryWrite
} from "./memory.js";
import { stateRead, stateWrite } from "./state.js";
import { cellRead, cellWrite } from "./cells.js";
import type {
  DeclaredOperationInputs,
  OperationEmitTarget,
  OperationValueEmitter
} from "./definition.js";

export type OperationWithResult =
  | ReturnType<typeof stateRead.create>
  | ReturnType<typeof memoryRead.create>
  | ReturnType<typeof memoryCheck.create>
  | ReturnType<typeof memoryResolve.create>
  | ReturnType<typeof resolveFlag.create>
  | ReturnType<typeof cellRead.create>;

export type OperationWithoutResult =
  | ReturnType<typeof stateWrite.create>
  | ReturnType<typeof memoryWrite.create>
  | ReturnType<typeof cellWrite.create>;

export type Operation = OperationWithResult | OperationWithoutResult;

export function emitOperation(
  target: OperationEmitTarget,
  values: OperationValueEmitter,
  operation: Operation
): void {
  const declared = operation.inputs;
  const consumedInputs = new Set<number>();

  function consumeInput(index: number) {
    const input = declared[index];

    assert(input !== undefined, `unknown operation input ${index}`);
    assert(
      !consumedInputs.has(index),
      `operation input ${index} is consumed more than once`
    );
    consumedInputs.add(index);
    return input;
  }

  const inputs: DeclaredOperationInputs = {
    use(index) {
      values.emitUse(consumeInput(index).value);
    },
    constValue(index) {
      const input = declared[index];

      assert(input !== undefined, `unknown operation input ${index}`);
      assert(
        !consumedInputs.has(index),
        `operation input ${index} is consumed more than once`
      );
      const value = values.constValue(input.value);

      if (value !== undefined) {
        consumedInputs.add(index);
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
    case cellRead.kind:
      cellRead.emit(operation, target, inputs);
      break;
    case cellWrite.kind:
      cellWrite.emit(operation, target, inputs);
      break;
    default: {
      const unhandled: never = operation;
      assert(false, `unhandled IR operation ${String(unhandled)}`);
    }
  }

  for (const index of declared.keys()) {
    assert(consumedInputs.has(index), `operation input ${index} was not consumed`);
  }
}
