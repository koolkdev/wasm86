import { assert } from "#common/assert.js";
import {
  Invocation,
  invocationInputs
} from "#compiler/ir/invocation.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  operationResult,
  type OperationDefinition,
  type OperationNodeBase,
  type OperationProduction
} from "./definition.js";

export type CallOperationArgs = Readonly<{
  invocation: Invocation;
}>;

export type CallOperation = OperationNodeBase & Readonly<{
  kind: "call";
  invocation: Invocation;
  output?: ValueId;
}>;

export const callOperation: OperationDefinition<
  CallOperationArgs,
  CallOperation,
  readonly OperationProduction[]
> = {
  kind: "call",
  create: ({ invocation }, allocateOutput) => {
    const results = invocation.target.type.results;

    assert(
      results.length <= 1,
      `call has ${results.length} results; multiple call results are not supported yet`
    );

    const result = results[0];
    if (result === undefined) {
      return { category: "operation", kind: "call", invocation };
    }

    return {
      category: "operation",
      kind: "call",
      invocation,
      output: allocateOutput(operationResult(result))
    };
  },
  describe: (operation) => {
    const resultType = operation.invocation.target.type.results[0];
    const productions = resultType === undefined || operation.output === undefined
      ? []
      : [{
          result: operationResult(resultType),
          output: operation.output
        }];

    return {
      inputs: invocationInputs(operation.invocation),
      productions,
      effects: operation.invocation.target.effects
    };
  }
};
