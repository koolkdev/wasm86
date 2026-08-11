import { Control } from "#compiler/function/control.js";
import { Invocation, type CallTarget } from "#compiler/function/invocation.js";
import { Operation } from "#compiler/function/operation.js";
import type { AnyResourceAccess } from "#compiler/function/resource.js";
import type { Region, RegionNode } from "#compiler/function/region.js";
import { VariableRef } from "#compiler/function/storage.js";
import type { FunctionType } from "#compiler/function/type.js";
import {
  Integer,
  valueTypeOf,
  type AnyInteger,
  type AnyValue,
  type ValueForType,
  type ValueTuple,
  type ValueType,
  type ValueTypeOf
} from "#compiler/function/values.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import { ValueResolver } from "#compiler/function/values/resolver.js";

type ResultlessFunction = FunctionType<readonly ValueType[], readonly []>;
type SingleResultFunction = FunctionType<readonly ValueType[], readonly [ValueType]>;
type CallableFunction = ResultlessFunction | SingleResultFunction;

export class RegionBuilder<FunctionResults extends readonly ValueType[] = readonly ValueType[]> {
  readonly #nodes: RegionNode[] = [];
  readonly #values: ValueResolver;

  constructor(values: ValueResolver) {
    this.#values = values;
  }

  variable<Value extends AnyValue>(seed: Value): VariableRef<ValueTypeOf<Value>>;
  variable(seed: AnyValue): VariableRef {
    const variable = new VariableRef(valueTypeOf(seed));

    this.#values.resolve(seed);
    this.#nodes.push(Operation.variableWrite(variable, seed, "seed"));
    return variable;
  }

  read<Type extends ValueType>(variable: VariableRef<Type>): ValueForType<Type> {
    const output = this.#values.producer(variable.type);

    this.#nodes.push(Operation.variableRead(variable, output));
    return output;
  }

  write<Type extends ValueType>(
    variable: VariableRef<Type>,
    value: NoInfer<ValueForType<Type>>
  ): void {
    this.#values.resolve(value);
    this.#nodes.push(Operation.variableWrite(variable, value, "update"));
  }

  readResource<Access extends AnyResourceAccess>(source: Access): Integer<Access["valueWidth"]> {
    // Record dependencies before minting the operation's output value.
    this.#values.resolve(source.address.base);
    const output = produceInteger(this.#values, source.valueWidth);

    this.#nodes.push(Operation.resourceRead(source, output));
    return output;
  }

  writeResource<Access extends AnyResourceAccess>(
    destination: Access,
    value: NoInfer<Integer<Access["valueWidth"]>>
  ): void {
    this.#values.resolve(destination.address.base);
    this.#values.resolve(value);
    this.#nodes.push(Operation.resourceWrite(destination, value));
  }

  call<Type extends CallableFunction>(
    target: CallTarget<Type>,
    args: ValueTuple<NoInfer<Type["parameters"]>>
  ): ValueTuple<Type["results"]>;
  call(target: CallTarget, args: readonly AnyValue[]): readonly AnyValue[] {
    const invocation = this.#invocation(target, args);
    const resultType = target.type.results[0];

    if (resultType === undefined) {
      this.#nodes.push(Operation.call(invocation as Invocation<ResultlessFunction>));
      return [];
    }
    const output = this.#values.producer(resultType);

    this.#nodes.push(Operation.call(invocation as Invocation<SingleResultFunction>, output));
    return [output];
  }

  return(results: ValueTuple<NoInfer<FunctionResults>>): void {
    for (const value of results) {
      this.#values.resolve(value);
    }
    this.#nodes.push(Control.return({ source: { kind: "values", values: results } }));
  }

  returnCall<Type extends FunctionType<readonly ValueType[], FunctionResults>>(
    target: CallTarget<Type>,
    args: ValueTuple<NoInfer<Type["parameters"]>>
  ): void {
    const invocation = this.#invocation(target, args);

    this.#nodes.push(Control.return({ source: { kind: "invocation", invocation } }));
  }

  build(): Region {
    return { nodes: [...this.#nodes] };
  }

  #invocation<Type extends FunctionType>(
    target: CallTarget<Type>,
    args: ValueTuple<Type["parameters"]>
  ): Invocation<Type> {
    for (const value of args) {
      this.#values.resolve(value);
    }
    return Invocation.create({ target, arguments: args });
  }
}

function produceInteger<Width extends IntegerWidth>(
  values: ValueResolver,
  width: Width
): Integer<Width>;
function produceInteger(values: ValueResolver, width: IntegerWidth): AnyInteger {
  switch (width) {
    case 1:
      return values.producer(Integer[1]);
    case 8:
      return values.producer(Integer[8]);
    case 16:
      return values.producer(Integer[16]);
    case 32:
      return values.producer(Integer[32]);
    case 64:
      return values.producer(Integer[64]);
  }
}
