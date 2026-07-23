import type { VariableRef } from "#compiler/ir/variable.js";
import type { ValueId, ValueInput } from "#compiler/ir/values/types.js";
import {
  operationResult,
  OperationBase,
  type OperationFactory,
  type OperationOutputAllocator,
  type OperationResult
} from "./definition.js";

type VariableReadArgs = Readonly<{
  variable: VariableRef;
}>;

export class VariableReadOperation extends OperationBase {
  static readonly kind = "variable.read";
  readonly kind = VariableReadOperation.kind;
  declare readonly inputs: readonly [];
  declare readonly results: readonly [OperationResult];

  private constructor(
    readonly variable: VariableRef,
    result: OperationResult,
    output: ValueId
  ) {
    super({
      inputs: [],
      results: [result],
      outputs: [output],
      directEffects: {
        reads: [{ space: "variable", variable }],
        writes: []
      }
    });
  }

  static create(
    { variable }: VariableReadArgs,
    allocateOutput: OperationOutputAllocator
  ): VariableReadOperation {
    const result = operationResult(variable.type);

    return new VariableReadOperation(variable, result, allocateOutput(result));
  }
}

export const variableRead = VariableReadOperation satisfies OperationFactory<
  VariableReadArgs,
  VariableReadOperation
>;

export type VariableWriteInitialization = "seed" | "update";

type VariableWriteArgs = Readonly<{
  variable: VariableRef;
  value: ValueId;
  initialization: VariableWriteInitialization;
}>;

export class VariableWriteOperation extends OperationBase {
  static readonly kind = "variable.write";
  readonly kind = VariableWriteOperation.kind;
  declare readonly inputs: readonly [ValueInput];
  declare readonly results: readonly [];

  private constructor(
    readonly variable: VariableRef,
    readonly value: ValueId,
    readonly initialization: VariableWriteInitialization
  ) {
    const inputs: readonly [ValueInput] = [{ value, type: variable.type }];

    super({
      inputs,
      results: [],
      outputs: [],
      directEffects: {
        reads: [],
        writes: [{ space: "variable", variable }]
      }
    });
  }

  static create({
    variable,
    value,
    initialization
  }: VariableWriteArgs): VariableWriteOperation {
    return new VariableWriteOperation(variable, value, initialization);
  }
}

export const variableWrite = VariableWriteOperation satisfies OperationFactory<
  VariableWriteArgs,
  VariableWriteOperation
>;
