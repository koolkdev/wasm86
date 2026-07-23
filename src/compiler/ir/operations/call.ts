import { assert } from "#common/assert.js";
import { Invocation } from "#compiler/ir/invocation.js";
import type { ValueUseEmitter } from "#compiler/ir/node.js";
import {
  operationResult,
  OperationBase,
  type OperationEmitTarget,
  type OperationFactory,
  type OperationOutputAllocator,
  type OperationResult
} from "./definition.js";

export type CallOperationArgs = Readonly<{
  invocation: Invocation;
}>;

export class CallOperation extends OperationBase {
  static readonly kind = "call";
  readonly kind = CallOperation.kind;

  private constructor(
    readonly invocation: Invocation,
    allocateOutput: OperationOutputAllocator
  ) {
    const { type, effects } = invocation.target;

    assert(
      type.results.length <= 1,
      `call has ${type.results.length} results; multiple call results are not supported yet`
    );

    const results: readonly OperationResult[] = type.results.map(
      operationResult
    );
    const outputs = results.map(allocateOutput);

    super({
      inputs: invocation.inputs,
      results,
      outputs,
      directEffects: effects
    });
  }

  static create(
    { invocation }: CallOperationArgs,
    allocateOutput: OperationOutputAllocator
  ): CallOperation {
    return new CallOperation(invocation, allocateOutput);
  }

  emit(target: OperationEmitTarget, values: ValueUseEmitter): void {
    this.invocation.emitInputs(values);
    target.emitCall(this.invocation.target);
  }
}

export const callOperation = CallOperation satisfies OperationFactory<
  CallOperationArgs,
  CallOperation
>;
