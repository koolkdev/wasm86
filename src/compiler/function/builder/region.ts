import { assert } from "#common/assert.js";
import { Control, type BranchHint } from "#compiler/function/control.js";
import { Invocation, type CallTarget } from "#compiler/function/invocation.js";
import { Operation } from "#compiler/function/operation.js";
import type {
  ResourceAccess,
  ResourceEffect,
  StorageWidth,
  ValueWidthForStorage
} from "#compiler/function/resource.js";
import type { Region, RegionNode } from "#compiler/function/region.js";
import { VariableRef } from "#compiler/function/storage.js";
import type { FunctionType } from "#compiler/function/type.js";
import {
  Integer,
  sameValueType,
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
import {
  BufferedRegionNodeSink,
  LoopBodySink,
  type ResourceReadPlacement,
  type RegionNodeSink
} from "./region-sink.js";

type ResultlessFunction = FunctionType<readonly ValueType[], readonly []>;
type SingleResultFunction = FunctionType<readonly ValueType[], readonly [ValueType]>;
type CallableFunction = ResultlessFunction | SingleResultFunction;

type BuildBody<FunctionResults extends readonly ValueType[]> = (
  body: RegionBuilder<FunctionResults>
) => void;

type BuildResult<FunctionResults extends readonly ValueType[], Value extends AnyValue> = (
  body: RegionBuilder<FunctionResults>
) => Value;

type BuildInteger<FunctionResults extends readonly ValueType[], Width extends IntegerWidth> = (
  body: RegionBuilder<FunctionResults>
) => Integer<Width>;

type IfOptions<FunctionResults extends readonly ValueType[]> = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody<FunctionResults>;
}>;

type IfValueOptions = Readonly<{
  hint?: BranchHint;
}>;

type IfControlBodies = Readonly<{
  thenBody: Region;
  elseBody?: Region;
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

type LoopInputs<Seeds extends readonly AnyValue[]> = {
  readonly [Index in keyof Seeds]: Seeds[Index] extends AnyValue
    ? ValueForType<ValueTypeOf<Seeds[Index]>>
    : never;
};

type BuildLoopBody<
  FunctionResults extends readonly ValueType[],
  Seeds extends readonly AnyValue[]
> = (body: RegionBuilder<FunctionResults>, inputs: LoopInputs<Seeds>) => void;

type ResultRegion<Value extends AnyValue> = Region & Readonly<{ result: Value }>;

export type LoopOptions = Readonly<{
  resourceReadPlacement?: (effect: ResourceEffect) => ResourceReadPlacement;
}>;

const regionNodeSink = Symbol("regionNodeSink");

type RegionBuilderOptions = Readonly<{
  [regionNodeSink]?: RegionNodeSink;
}>;

export class RegionBuilder<FunctionResults extends readonly ValueType[] = readonly ValueType[]> {
  readonly #sink: RegionNodeSink;
  readonly #writtenVariables = new Set<VariableRef>();
  readonly #values: ValueResolver;
  #loopContinueTypes: readonly ValueType[] | undefined;

  constructor(values: ValueResolver, options: RegionBuilderOptions = {}) {
    this.#values = values;
    this.#sink = options[regionNodeSink] ?? new BufferedRegionNodeSink();
  }

  constValue(value: AnyNarrowInteger): number | undefined {
    return this.#values.constValue(value);
  }

  sameValue(a: AnyValue, b: AnyValue): boolean {
    return this.#values.sameValue(a, b);
  }

  child(): RegionBuilder<FunctionResults> {
    return this.#child(new BufferedRegionNodeSink());
  }

  // Scratch construction isolates its nodes but shares the function's value
  // resolver, so source values already visible to the function remain usable.
  scratch(): RegionBuilder<FunctionResults> {
    return new RegionBuilder<FunctionResults>(this.#values);
  }

  variable<Value extends AnyValue>(seed: Value): VariableRef<ValueTypeOf<Value>>;
  variable(seed: AnyValue): VariableRef {
    const variable = new VariableRef(valueTypeOf(seed));

    this.#values.resolve(seed);
    this.#emit(Operation.variableWrite(variable, seed, "seed"));
    return variable;
  }

  read<Type extends ValueType>(variable: VariableRef<Type>): ValueForType<Type> {
    const output = this.#values.producer(variable.type);

    this.#emit(Operation.variableRead(variable, output));
    return output;
  }

  write<Type extends ValueType>(
    variable: VariableRef<Type>,
    value: NoInfer<ValueForType<Type>>
  ): void {
    this.#values.resolve(value);
    this.#emit(Operation.variableWrite(variable, value, "update"));
  }

  readResource<
    StoredWidth extends StorageWidth,
    ValueWidth extends ValueWidthForStorage<StoredWidth>
  >(source: ResourceAccess<StoredWidth, ValueWidth>): Integer<ValueWidth> {
    // Record dependencies before minting the operation's output value.
    this.#values.resolve(source.address.base);
    const output = produceInteger(this.#values, source.valueWidth);

    this.#emit(Operation.resourceRead(source, output));
    return output;
  }

  writeResource<
    StoredWidth extends StorageWidth,
    ValueWidth extends ValueWidthForStorage<StoredWidth>
  >(
    destination: ResourceAccess<StoredWidth, ValueWidth>,
    value: NoInfer<Integer<ValueWidth>>
  ): void {
    this.#values.resolve(destination.address.base);
    this.#values.resolve(value);
    this.#emit(Operation.resourceWrite(destination, value));
  }

  call<Type extends CallableFunction>(
    target: CallTarget<Type>,
    args: ValueTuple<NoInfer<Type["parameters"]>>
  ): ValueTuple<Type["results"]>;
  call(target: CallTarget, args: readonly AnyValue[]): readonly AnyValue[] {
    const invocation = this.#invocation(target, args);
    const resultType = target.type.results[0];

    if (resultType === undefined) {
      this.#emit(Operation.call(invocation as Invocation<ResultlessFunction>));
      return [];
    }
    const output = this.#values.producer(resultType);

    this.#emit(Operation.call(invocation as Invocation<SingleResultFunction>, output));
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

    this.#emit(
      Control.if({
        condition,
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        thenBody,
        ...(elseBody === undefined ? {} : { elseBody })
      })
    );
  }

  ifValue<Width extends IntegerWidth>(
    condition: BitValue,
    thenBuild: BuildInteger<FunctionResults, Width>,
    elseBuild: BuildInteger<FunctionResults, NoInfer<Width>>,
    options?: IfValueOptions
  ): Integer<Width>;
  ifValue<Value extends AnyValue>(
    condition: BitValue,
    thenBuild: BuildResult<FunctionResults, Value>,
    elseBuild: BuildResult<FunctionResults, NoInfer<Value>>,
    options?: IfValueOptions
  ): Value;
  ifValue(
    condition: BitValue,
    thenBuild: BuildResult<FunctionResults, AnyValue>,
    elseBuild: BuildResult<FunctionResults, AnyValue>,
    options: IfValueOptions = {}
  ): AnyValue {
    this.#values.resolve(condition);
    const thenBody = this.#childResultBody(thenBuild);
    const elseBody = this.#childResultBody(elseBuild);
    const output = produceResult(this.#values, thenBody.result);

    this.#emit(
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

  ifControl(condition: BitValue, control: IfControlBodies): void {
    this.#values.resolve(condition);
    this.#emit(
      Control.if({
        condition,
        ...(control.hint === undefined ? {} : { hint: control.hint }),
        thenBody: control.thenBody,
        ...(control.elseBody === undefined ? {} : { elseBody: control.elseBody })
      })
    );
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

    this.#emit(Control.switch({ selector, output, cases, defaultBody }));
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

    this.#emit(Control.switch({ selector, cases, defaultBody }));
  }

  loop<const Seeds extends readonly AnyValue[]>(
    seeds: Seeds,
    build: BuildLoopBody<FunctionResults, NoInfer<Seeds>>,
    options: LoopOptions = {}
  ): void {
    for (const seed of seeds) {
      this.#values.resolve(seed);
    }
    const body = this.#child(
      options.resourceReadPlacement === undefined
        ? new BufferedRegionNodeSink()
        : new LoopBodySink((node) => this.#emit(node), options.resourceReadPlacement),
      seeds.map((seed) => valueTypeOf(seed))
    );
    const inputs = createLoopInputs(this.#values, seeds);

    build(body, inputs);
    this.#emit(
      Control.loop({
        carried: seeds.map((seed, index) => {
          const loopInput = inputs[index];

          assert(loopInput !== undefined, `loop seed ${index} has no input`);
          return { seed, loopInput };
        }),
        body: body.build()
      })
    );
  }

  loopContinue(updates: readonly AnyValue[]): void {
    const expectedTypes = this.#loopContinueTypes;

    assert(expectedTypes !== undefined, "loopContinue requires an enclosing loop");
    assert(updates.length === expectedTypes.length, "loop updates do not align with their loop");
    for (const [index, update] of updates.entries()) {
      const expected = expectedTypes[index];

      assert(
        expected !== undefined && sameValueType(valueTypeOf(update), expected),
        `loop update ${index} has the wrong value type`
      );
    }
    for (const update of updates) {
      this.#values.resolve(update);
    }
    this.#emit(Control.loopContinue({ updates }));
  }

  return(results: ValueTuple<NoInfer<FunctionResults>>): void {
    for (const value of results) {
      this.#values.resolve(value);
    }
    this.#emit(Control.return({ source: { kind: "values", values: results } }));
  }

  returnCall<Type extends FunctionType<readonly ValueType[], FunctionResults>>(
    target: CallTarget<Type>,
    args: ValueTuple<NoInfer<Type["parameters"]>>
  ): void {
    const invocation = this.#invocation(target, args);

    this.#emit(Control.return({ source: { kind: "invocation", invocation } }));
  }

  build(): Region {
    const nodes = this.#sink.nodes();
    const last = nodes[nodes.length - 1];

    return {
      nodes,
      writtenVariables: new Set(this.#writtenVariables),
      fallsThrough:
        last === undefined || last.category === "operation" || Control.describe(last).fallsThrough
    };
  }

  #emit(node: RegionNode): void {
    if (this.#sink.append(node) === "routed") {
      return;
    }
    this.#recordWrites(node);
  }

  #recordWrites(node: RegionNode): void {
    if (node.category === "operation") {
      if (node.kind === "variable.write") {
        this.#writtenVariables.add(node.variable);
      }
      return;
    }
    for (const { body } of Control.describe(node).regions) {
      for (const variable of body.writtenVariables) {
        this.#writtenVariables.add(variable);
      }
    }
  }

  #child(
    sink: RegionNodeSink,
    loopContinueTypes: readonly ValueType[] | undefined = this.#loopContinueTypes
  ): RegionBuilder<FunctionResults> {
    const child = new RegionBuilder<FunctionResults>(this.#values, {
      [regionNodeSink]: sink
    });

    child.#loopContinueTypes = loopContinueTypes;
    return child;
  }

  #childBody(build: BuildBody<FunctionResults>): Region {
    const child = this.child();

    build(child);
    return child.build();
  }

  #childResultBody<Value extends AnyValue>(
    build: BuildResult<FunctionResults, Value>
  ): ResultRegion<Value> {
    const child = this.child();
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

function createLoopInputs<const Seeds extends readonly AnyValue[]>(
  values: ValueResolver,
  seeds: Seeds
): LoopInputs<Seeds>;
function createLoopInputs(values: ValueResolver, seeds: readonly AnyValue[]): readonly AnyValue[] {
  return seeds.map((seed) => values.producer(valueTypeOf(seed)));
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
