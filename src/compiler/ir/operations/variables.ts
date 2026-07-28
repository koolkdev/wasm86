import type { VariableRef } from "#compiler/ir/variable.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  operationResult,
  type OperationDefinition,
  type OperationNodeBase,
  type OperationProduction
} from "./definition.js";

type VariableReadArgs = Readonly<{
  variable: VariableRef;
}>;

export type VariableReadOperation = OperationNodeBase &
  Readonly<{
    kind: "variable.read";
    variable: VariableRef;
    output: ValueId;
  }>;

export const variableRead: OperationDefinition<
  VariableReadArgs,
  VariableReadOperation,
  readonly [OperationProduction]
> = {
  kind: "variable.read",
  create: ({ variable }, allocateOutput) => {
    const result = operationResult(variable.type);

    return {
      category: "operation",
      kind: "variable.read",
      variable,
      output: allocateOutput(result)
    };
  },
  describe: (operation) => ({
    inputs: [],
    productions: [
      {
        result: operationResult(operation.variable.type),
        output: operation.output
      }
    ],
    effects: {
      reads: [{ space: "variable", variable: operation.variable }],
      writes: []
    }
  })
};

export type VariableWriteInitialization = "seed" | "update";

type VariableWriteArgs = Readonly<{
  variable: VariableRef;
  value: ValueId;
  initialization: VariableWriteInitialization;
}>;

export type VariableWriteOperation = OperationNodeBase &
  Readonly<{
    kind: "variable.write";
    variable: VariableRef;
    value: ValueId;
    initialization: VariableWriteInitialization;
  }>;

export const variableWrite: OperationDefinition<
  VariableWriteArgs,
  VariableWriteOperation,
  readonly []
> = {
  kind: "variable.write",
  create: ({ variable, value, initialization }) => ({
    category: "operation",
    kind: "variable.write",
    variable,
    value,
    initialization
  }),
  describe: (operation) => ({
    inputs: [{ value: operation.value, type: operation.variable.type }],
    productions: [],
    effects: {
      reads: [],
      writes: [{ space: "variable", variable: operation.variable }]
    }
  })
};
