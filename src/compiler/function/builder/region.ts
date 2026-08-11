import { Control, type BranchHint } from "#compiler/function/control.js";
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
  type AnyNarrowInteger,
  type AnyValue,
  type BitValue,
  type I32Value,
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

type BuildBody<FunctionResults extends readonly ValueType[]> = (
  body: RegionBuilder<FunctionResults>
) => void;

type BuildResult<FunctionResults extends readonly ValueType[], Value extends AnyValue> = (
  body: RegionBuilder<FunctionResults>
) => Value;

type IfOptions<FunctionResults extends readonly ValueType[]> = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody<FunctionResults>;
}>;

type IfValueOptions = Readonly<{
  hint?: BranchHint;
}>;

export type SwitchArm<
  Value extends AnyValue = I32Value,
  FunctionResults extends readonly ValueType[] = readonly ValueType[]
> = Readonly<{
  match: number;
  build: BuildResult<FunctionResults, Value>;
}>;

export type SwitchControlArm<FunctionResults extends readonly ValueType[] = readonly ValueType[]> =
  Readonly<{
    matches: readonly number[];
    build: BuildBody<FunctionResults>;
  }>;

type ResultRegion<Value extends AnyValue> = Region & Readonly<{ result: Value }>;

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

  if(
    condition: BitValue,
    thenBuild: BuildBody<FunctionResults>,
    options: IfOptions<FunctionResults> = {}
  ): void {
    this.#values.resolve(condition);
    const thenBody = this.#childBody(thenBuild);
    const elseBody =
      options.elseBuild === undefined ? undefined : this.#childBody(options.elseBuild);

    this.#nodes.push(
      Control.if({
        condition,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        thenBody,
        ...(elseBody === undefined ? {} : { elseBody })
      })
    );
  }

  ifValue<Value extends AnyValue>(
    condition: BitValue,
    thenBuild: BuildResult<FunctionResults, Value>,
    elseBuild: BuildResult<FunctionResults, NoInfer<Value>>,
    options: IfValueOptions = {}
  ): Value {
    this.#values.resolve(condition);
    const thenBody = this.#childResultBody(thenBuild);
    const elseBody = this.#childResultBody(elseBuild);
    const output = produceResult(this.#values, thenBody.result);

    this.#nodes.push(
      Control.if({
        condition,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        output,
        thenBody,
        elseBody
      })
    );
    return output;
  }

  switch<Value extends AnyValue>(
    selector: AnyNarrowInteger,
    arms: readonly SwitchArm<NoInfer<Value>, FunctionResults>[],
    defaultBuild: BuildResult<FunctionResults, Value>
  ): Value {
    this.#values.resolve(selector);
    // The default result anchors the joined value type, so resolve it before the cases.
    const defaultBody = this.#childResultBody(defaultBuild);
    const cases = arms.map(({ match, build }) => ({
      matches: [match],
      body: this.#childResultBody(build)
    }));
    const output = produceResult(this.#values, defaultBody.result);

    this.#nodes.push(Control.switch({ selector, output, cases, defaultBody }));
    return output;
  }

  switchControl(
    selector: AnyNarrowInteger,
    arms: readonly SwitchControlArm<FunctionResults>[],
    defaultBuild: BuildBody<FunctionResults>
  ): void {
    this.#values.resolve(selector);
    const cases = arms.map(({ matches, build }) => ({
      matches,
      body: this.#childBody(build)
    }));
    const defaultBody = this.#childBody(defaultBuild);

    this.#nodes.push(Control.switch({ selector, cases, defaultBody }));
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

  #childBody(build: BuildBody<FunctionResults>): Region {
    const child = new RegionBuilder<FunctionResults>(this.#values);

    build(child);
    return child.build();
  }

  #childResultBody<Value extends AnyValue>(
    build: BuildResult<FunctionResults, Value>
  ): ResultRegion<Value> {
    const child = new RegionBuilder<FunctionResults>(this.#values);
    const result = build(child);

    this.#values.resolve(result);
    return { ...child.build(), result };
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

function produceResult<Value extends AnyValue>(values: ValueResolver, result: Value): Value;
function produceResult(values: ValueResolver, result: AnyValue): AnyValue {
  return values.producer(valueTypeOf(result));
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
