import type { ValueWidth } from "#compiler/integer/width.js";
import type { ValueId, ValueType } from "#compiler/value.js";
import type { ValueDefinition } from "./graph/definition.js";
import type { ValueNode } from "./graph/node.js";
import type { ValueHandle } from "./handle.js";

export type ValueInputs = Readonly<{
  value<Type extends ValueType>(value: ValueHandle<Type>): ValueId;
}>;

export type ValueOperation<Input, Args, Node extends ValueNode> = ValueDefinition<Args, Node> &
  Readonly<{
    resolve: (input: Input, values: ValueInputs) => Args;
  }>;

export type ValueResolutionContext = ValueInputs &
  Readonly<{
    create<Args, Node extends ValueNode>(
      definition: ValueDefinition<Args, Node>,
      args: Args
    ): ValueId;
    bitWidth(id: ValueId): ValueWidth;
  }>;

export interface ValueExpression {
  resolve(context: ValueResolutionContext): ValueId;
}

export function operationExpression<Input, Args, Node extends ValueNode>(
  operation: ValueOperation<Input, Args, Node>,
  input: NoInfer<Input>
): ValueExpression {
  return new OperationExpression(operation, input);
}

class OperationExpression<Input, Args, Node extends ValueNode> implements ValueExpression {
  constructor(
    private readonly operation: ValueOperation<Input, Args, Node>,
    private readonly input: Input
  ) {}

  resolve(context: ValueResolutionContext): ValueId {
    return context.create(this.operation, this.operation.resolve(this.input, context));
  }
}
