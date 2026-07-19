import { assert } from "#common/assert.js";
import type { ValueInput } from "#compiler/ir/values/types.js";
import type { FunctionDefinition } from "#compiler/program/functions.js";
import type { ValueUseEmitter } from "#ir/node.js";
import {
  operationResult,
  OperationBase,
  type OperationEmitTarget,
  type OperationFactory,
  type OperationOutputAllocator,
  type OperationResult
} from "./definition.js";

export type CallOperationArgs = Readonly<{
  target: FunctionDefinition;
  arguments: readonly ValueInput[];
}>;

export class CallOperation extends OperationBase {
  static readonly kind = "call";
  readonly kind = CallOperation.kind;

  private constructor(
    readonly target: FunctionDefinition,
    inputs: readonly ValueInput[],
    allocateOutput: OperationOutputAllocator
  ) {
    assert(
      inputs.length === target.type.parameters.length,
      `function ${target.ref.id} expects ${target.type.parameters.length} arguments, got ${inputs.length}`
    );
    for (const [index, input] of inputs.entries()) {
      const expected = target.type.parameters[index];

      assert(
        expected !== undefined,
        `function ${target.ref.id} has no parameter ${index}`
      );
      assert(
        input.type === expected,
        `function ${target.ref.id} argument ${index} must be ${expected}, got ${input.type}`
      );
    }
    assert(
      target.type.results.length <= 1,
      `function ${target.ref.id} has ${target.type.results.length} results; multiple call results are not supported yet`
    );

    const results: readonly OperationResult[] = target.type.results.map(
      operationResult
    );
    const outputs = results.map(allocateOutput);

    super({
      inputs,
      results,
      outputs,
      directEffects: target.effects
    });
  }

  static create(
    { target, arguments: inputs }: CallOperationArgs,
    allocateOutput: OperationOutputAllocator
  ): CallOperation {
    return new CallOperation(target, inputs, allocateOutput);
  }

  emit(target: OperationEmitTarget, values: ValueUseEmitter): void {
    for (const input of this.inputs) {
      values.emitUse(input.value);
    }
    target.body.callFunction(target.functionIndex(this.target));
  }
}

export const callOperation = CallOperation satisfies OperationFactory<
  CallOperationArgs,
  CallOperation
>;
