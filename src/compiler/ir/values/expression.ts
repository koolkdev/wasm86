import type { IntegerWidth } from "#compiler/integer/width.js";
import type { ValueId } from "#compiler/ir/value.js";
import type { ValueDefinition } from "./graph/definition.js";
import type { ValueNode } from "./graph/node.js";
import type { ValueTable } from "./graph/table.js";
import type { ValueHandle } from "./handle.js";

export type ValueInputs = Readonly<{
  value<Width extends IntegerWidth>(value: ValueHandle<Width>): ValueId;
}>;

export type ValueOperation<Input, Args, Node extends ValueNode> = ValueDefinition<Args, Node> &
  Readonly<{
    resolve: (input: Input, values: ValueInputs) => Args;
  }>;

export type ValueScopeRequirement = Readonly<{
  origin: ValueTable;
  id: ValueId;
}>;

export type ValueResolutionContext = ValueInputs &
  Readonly<{
    create<Args, Node extends ValueNode>(
      definition: ValueDefinition<Args, Node>,
      args: Args
    ): ValueId;
    require(requirement: ValueScopeRequirement): void;
    bitWidth(id: ValueId): IntegerWidth;
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

export function boundExpression(requirement: ValueScopeRequirement): ValueExpression {
  return new BoundExpression(requirement);
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

class BoundExpression implements ValueExpression {
  constructor(private readonly requirement: ValueScopeRequirement) {}

  resolve(context: ValueResolutionContext): ValueId {
    context.require(this.requirement);
    return this.requirement.id;
  }
}
