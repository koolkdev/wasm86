import { assert } from "#common/assert.js";
import type { Invocation } from "#compiler/function/invocation.js";
import type {
  AnyResourceAccess,
  ResourceAccess,
  StorageWidth,
  ValueWidthForStorage
} from "#compiler/function/resource.js";
import type { StorageEffects, VariableRef } from "#compiler/function/storage.js";
import type { IntegerRef } from "#compiler/function/values/expression.js";
import type { ValueRef } from "#compiler/function/values.js";
import { Integer, type ValueForType, type ValueType } from "#compiler/function/values/type.js";
import type { FunctionType } from "./type.js";

type OperationNode<Kind extends string> = Readonly<{
  category: "operation";
  kind: Kind;
}>;

export type CallOperation = OperationNode<"call"> &
  Readonly<{
    invocation: Invocation;
    output?: ValueRef;
  }>;

export type ResourceReadOperation = OperationNode<"resource.read"> &
  Readonly<{
    source: AnyResourceAccess;
    output: IntegerRef;
  }>;

export type ResourceWriteOperation = OperationNode<"resource.write"> &
  Readonly<{
    destination: AnyResourceAccess;
    value: IntegerRef;
  }>;

export type VariableReadOperation = OperationNode<"variable.read"> &
  Readonly<{ variable: VariableRef; output: ValueRef }>;

export type VariableWriteInitialization = "seed" | "update";

export type VariableWriteOperation = OperationNode<"variable.write"> &
  Readonly<{
    variable: VariableRef;
    value: ValueRef;
    initialization: VariableWriteInitialization;
  }>;

export type Operation =
  | CallOperation
  | ResourceReadOperation
  | ResourceWriteOperation
  | VariableReadOperation
  | VariableWriteOperation;

export type OperationDescription = Readonly<{
  operands: readonly ValueRef[];
  output: ValueRef | undefined;
  resultType: ValueType | undefined;
  effects: StorageEffects;
}>;

type ResultlessFunction = FunctionType<readonly ValueType[], readonly []>;
type SingleResultFunction = FunctionType<readonly ValueType[], readonly [ValueType]>;

function call<Type extends ResultlessFunction>(invocation: Invocation<Type>): CallOperation;
function call<Type extends SingleResultFunction>(
  invocation: Invocation<Type>,
  output: NoInfer<ValueForType<Type["results"][0]>>
): CallOperation;
function call(invocation: Invocation, output?: ValueRef): CallOperation {
  const results = invocation.target.type.results;

  assert(
    results.length <= 1,
    `call has ${results.length} results; multiple call results are not supported yet`
  );

  const resultType = results[0];
  if (resultType === undefined) {
    assert(output === undefined, "resultless call has an output");
    return {
      category: "operation",
      kind: "call",
      invocation
    };
  }

  assert(output !== undefined, "value-producing call has no output");
  return {
    category: "operation",
    kind: "call",
    invocation,
    output
  };
}

function resourceRead<
  StoredWidth extends StorageWidth,
  ValueWidth extends ValueWidthForStorage<StoredWidth>
>(
  source: ResourceAccess<StoredWidth, ValueWidth>,
  output: NoInfer<IntegerRef<ValueWidth>>
): ResourceReadOperation {
  return {
    category: "operation",
    kind: "resource.read",
    source,
    output
  } as ResourceReadOperation;
}

function resourceWrite<
  StoredWidth extends StorageWidth,
  ValueWidth extends ValueWidthForStorage<StoredWidth>
>(
  destination: ResourceAccess<StoredWidth, ValueWidth>,
  value: NoInfer<IntegerRef<ValueWidth>>
): ResourceWriteOperation {
  return {
    category: "operation",
    kind: "resource.write",
    destination,
    value
  } as ResourceWriteOperation;
}

function variableRead<Type extends ValueType>(
  variable: VariableRef<Type>,
  output: NoInfer<ValueForType<Type>>
): VariableReadOperation {
  return {
    category: "operation",
    kind: "variable.read",
    variable,
    output
  };
}

function variableWrite<Type extends ValueType>(
  variable: VariableRef<Type>,
  value: NoInfer<ValueForType<Type>>,
  initialization: VariableWriteInitialization
): VariableWriteOperation {
  return {
    category: "operation",
    kind: "variable.write",
    variable,
    value,
    initialization
  };
}

function describe(operation: Operation): OperationDescription {
  switch (operation.kind) {
    case "call":
      return {
        operands: operation.invocation.arguments,
        output: operation.output,
        resultType: operation.invocation.target.type.results[0],
        effects: operation.invocation.target.effects
      };
    case "resource.read":
      return {
        operands: [operation.source.address.base],
        output: operation.output,
        resultType: Integer[operation.source.valueWidth],
        effects: { reads: [operation.source.effect], writes: [] }
      };
    case "resource.write":
      return {
        operands: [operation.destination.address.base, operation.value],
        output: undefined,
        resultType: undefined,
        effects: { reads: [], writes: [operation.destination.effect] }
      };
    case "variable.read":
      return {
        operands: [],
        output: operation.output,
        resultType: operation.variable.type,
        effects: { reads: [operation.variable], writes: [] }
      };
    case "variable.write":
      return {
        operands: [operation.value],
        output: undefined,
        resultType: undefined,
        effects: { reads: [], writes: [operation.variable] }
      };
  }
}

export const Operation = {
  call,
  resourceRead,
  resourceWrite,
  variableRead,
  variableWrite,
  describe
} as const;
