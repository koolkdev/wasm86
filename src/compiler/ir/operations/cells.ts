import type { CellRef } from "#compiler/refs/cell.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type {
  OperationDefinition,
  OperationResult
} from "./definition.js";

type CellReadArgs = Readonly<{
  cell: CellRef;
}>;

export const cellRead: OperationDefinition<
  "cell.read",
  CellReadArgs,
  OperationResult
> = {
  kind: "cell.read",

  create({ cell }) {
    return {
      kind: "cell.read",
      cell,
      inputs: [],
      result: { type: cell.type },
      effects: {
        reads: [{ space: "cell", cell }],
        writes: []
      }
    };
  },

  emit(operation, { body, cellLocal }) {
    body.localGet(cellLocal(operation.cell));
  }
};

export type CellWriteInitialization = "seed" | "update";

type CellWriteArgs = Readonly<{
  cell: CellRef;
  value: ValueId;
  initialization: CellWriteInitialization;
}>;

export const cellWrite: OperationDefinition<
  "cell.write",
  CellWriteArgs,
  undefined
> = {
  kind: "cell.write",

  create({ cell, value, initialization }) {
    return {
      kind: "cell.write",
      cell,
      value,
      initialization,
      inputs: [{ value, type: cell.type }],
      result: undefined,
      effects: {
        reads: [],
        writes: [{ space: "cell", cell }]
      }
    };
  },

  emit(operation, { body, cellLocal }, inputs) {
    inputs.use(0);
    body.localSet(cellLocal(operation.cell));
  }
};
