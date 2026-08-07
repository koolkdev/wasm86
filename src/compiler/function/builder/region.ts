import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { VariableRef } from "#compiler/function/storage.js";
import { Invocation, type CallTarget } from "#compiler/function/invocation.js";
import {
  callOperation,
  operationOutput,
  resourceRead,
  resourceWrite,
  variableRead,
  variableWrite
} from "#compiler/function/operation.js";
import {
  controlCompletes,
  controlOutput,
  controlRegions,
  ifControl as createIfControl,
  loopContinueControl as createLoopContinueControl,
  loopControl as createLoopControl,
  returnControl as createReturnControl,
  switchControl as createSwitchControl,
  type BranchHint
} from "#compiler/function/control.js";
import type { Region, RegionNode } from "../region.js";
import { ValueScope } from "#compiler/function/values/scope.js";
import type {
  AnyValue,
  AnyInteger,
  AnyNarrowInteger,
  Integer,
  BitValue,
  ValueRef,
  ValueTuple
} from "#compiler/function/values.js";
import { Integer as IntegerType, sameValueType, valueTypeOf } from "#compiler/function/values.js";
import type { FunctionType, ValueType } from "#compiler/function/type.js";
import { type StorageWidth, type StoredIntegerWidth } from "#compiler/function/resource.js";
import type { IntegerWidth } from "#compiler/function/values/integer/width.js";
import type { ResourceAccess, ResourceAccessNode } from "#compiler/function/resource.js";
import type { ResourceEffect } from "#compiler/function/resource.js";
import {
  BufferedRegionNodeSink,
  LoopBodySink,
  type ResourceReadPlacement,
  type RegionNodeSink
} from "./region-sink.js";

type BuildBody = (region: RegionBuilder) => void;
type BuildInteger<Width extends IntegerWidth> = (region: RegionBuilder) => Integer<Width>;
type BuildValue = (region: RegionBuilder) => AnyValue;
type BuildTypedValue<Value extends AnyValue> = (region: RegionBuilder) => Value;

export type SwitchArm<Width extends IntegerWidth = 32> = Readonly<{
  match: number;
  build: BuildInteger<Width>;
}>;
export type SwitchValueArm<Value extends AnyValue> = Readonly<{
  match: number;
  build: BuildTypedValue<Value>;
}>;
export type SwitchControlArm = Readonly<{
  matches: readonly number[];
  build: BuildBody;
}>;

type IfOptions = Readonly<{
  hint?: BranchHint;
  elseBuild?: BuildBody;
}>;

type IfValueOptions = Readonly<{
  hint?: BranchHint;
}>;

type IfControlBodies = Readonly<{
  thenBody: Region;
  elseBody?: Region;
  hint?: BranchHint;
}>;

type BuildLoopBody = {
  bivarianceHack(body: RegionBuilder, inputs: readonly AnyValue[]): void;
}["bivarianceHack"];

type LoopInputs<Seeds extends readonly AnyValue[]> = {
  readonly [Index in keyof Seeds]: Seeds[Index];
};

type LoopOptions = Readonly<{
  resourceReadPlacement?: (effect: ResourceEffect) => ResourceReadPlacement;
}>;

const regionNodeSink = Symbol("regionNodeSink");

type RegionBuilderOptions = Readonly<{
  [regionNodeSink]?: RegionNodeSink;
  functionResults?: readonly ValueType[];
}>;

type BuiltValueResult = Readonly<{
  body: Region;
  type: ValueType;
}>;

export class RegionBuilder {
  readonly #values: ValueScope;
  readonly #sink: RegionNodeSink;
  readonly #functionResults: readonly ValueType[] | undefined;
  readonly #writes = new Set<VariableRef>();
  #loopUpdateTypes: readonly ValueType[] | undefined;

  constructor(values: ValueScope, options: RegionBuilderOptions = {}) {
    this.#values = values;
    this.#sink = options[regionNodeSink] ?? new BufferedRegionNodeSink();
    this.#functionResults = options.functionResults;
  }

  child(): RegionBuilder {
    return this.#child(new BufferedRegionNodeSink());
  }

  #child(sink: RegionNodeSink): RegionBuilder {
    const child = new RegionBuilder(this.#values.childScope(), {
      [regionNodeSink]: sink,
      ...(this.#functionResults === undefined ? {} : { functionResults: this.#functionResults })
    });

    child.#loopUpdateTypes = this.#loopUpdateTypes;
    return child;
  }

  scratch(): RegionBuilder {
    return new RegionBuilder(this.#values.fork());
  }

  constValue(value: AnyNarrowInteger): number | undefined {
    return this.#values.constValue(value);
  }

  sameValue(a: AnyValue, b: AnyValue): boolean {
    return this.#values.sameValue(a, b);
  }

  variable<Width extends IntegerWidth>(seed: Integer<Width>): VariableRef<Width> {
    const variable = new VariableRef(seed.width);

    this.#values.resolve(seed);
    this.#emit(variableWrite(variable, seed, "seed"));
    return variable;
  }

  read<Width extends IntegerWidth>(variable: VariableRef<Width>): Integer<Width> {
    const output = integerProducer(this.#values, variable.width);
    const owner = this.#emit(variableRead(variable, output));

    return owner.#values.rebind(output);
  }

  write<Width extends IntegerWidth>(
    variable: VariableRef<Width>,
    value: Integer<NoInfer<Width>>
  ): void {
    this.#values.resolve(value);
    this.#emit(variableWrite(variable, value, "update"));
  }

  readResource<Width extends StorageWidth, TValueWidth extends StoredIntegerWidth<Width>>(
    source: ResourceAccess<Width, TValueWidth>
  ): Integer<TValueWidth> {
    this.#values.resolve(source.address.base);

    const sourceNode = this.#normalizeResourceAccess(source, source.address.base);
    const output = integerProducer(this.#values, source.valueWidth);
    const owner = this.#emit(resourceRead(sourceNode, output));

    return owner.#values.rebind(output);
  }

  writeResource<Width extends StorageWidth, TValueWidth extends StoredIntegerWidth<Width>>(
    destination: ResourceAccess<Width, TValueWidth>,
    value: Integer<NoInfer<TValueWidth>>
  ): void {
    this.#values.resolve(destination.address.base);
    this.#values.resolve(value);

    this.#emit(
      resourceWrite(this.#normalizeResourceAccess(destination, destination.address.base), value)
    );
  }

  call<Type extends FunctionType>(
    target: CallTarget<Type>,
    args: ValueTuple<NoInfer<Type["parameters"]>>
  ): ValueTuple<Type["results"]>;
  call(target: CallTarget, args: readonly AnyValue[]): readonly AnyValue[] {
    const invocation = this.#invocation(target, args);
    const result = target.type.results[0];
    const output = result === undefined ? undefined : this.#values.producer(result);
    const operation = callOperation(invocation, output);

    const owner = this.#emit(operation);
    return output === undefined ? [] : [owner.#values.rebind(output)];
  }

  returnCall<Type extends FunctionType>(
    target: CallTarget<Type>,
    args: ValueTuple<NoInfer<Type["parameters"]>>
  ): void;
  returnCall(target: CallTarget, args: readonly AnyValue[]): void {
    const functionResults = this.#functionResults;

    assert(functionResults !== undefined, "returnCall requires an enclosing function");
    const results = target.type.results;

    assert(
      results.length === functionResults.length &&
        results.every((type, index) => {
          const expected = functionResults[index];

          return expected !== undefined && sameValueType(type, expected);
        }),
      "call results do not match the enclosing function"
    );
    const invocation = this.#invocation(target, args);

    this.#emit(
      createReturnControl({
        source: { kind: "invocation", invocation }
      })
    );
  }

  if(condition: BitValue, thenBuild: BuildBody, options: IfOptions = {}): void {
    this.#values.resolve(condition);

    const thenBody = this.#childBody(thenBuild);
    const elseBody =
      options.elseBuild === undefined ? undefined : this.#childBody(options.elseBuild);

    this.#emit(
      createIfControl({
        condition,
        ...(options.hint !== undefined ? { hint: options.hint } : {}),
        thenBody,
        ...(elseBody !== undefined ? { elseBody } : {})
      })
    );
  }

  ifValue<Width extends IntegerWidth>(
    condition: BitValue,
    thenBuild: BuildInteger<Width>,
    elseBuild: BuildInteger<NoInfer<Width>>,
    options?: IfValueOptions
  ): Integer<Width>;
  ifValue<Value extends AnyValue>(
    condition: BitValue,
    thenBuild: BuildTypedValue<Value>,
    elseBuild: BuildTypedValue<NoInfer<Value>>,
    options?: IfValueOptions
  ): Value;
  ifValue(
    condition: BitValue,
    thenBuild: BuildValue,
    elseBuild: BuildValue,
    options: IfValueOptions = {}
  ): AnyValue {
    this.#values.resolve(condition);

    const thenResult = this.#childValueResultBody(thenBuild);
    const elseResult = this.#childValueResultBody(elseBuild);

    assert(
      sameValueType(elseResult.type, thenResult.type),
      "ifValue arms must have one value type"
    );
    this.#assertControlResults([thenResult.body, elseResult.body], thenResult.type);

    const output = this.#values.producer(thenResult.type);
    const owner = this.#emit(
      createIfControl({
        condition,
        ...(options.hint !== undefined ? { hint: options.hint } : {}),
        output,
        thenBody: thenResult.body,
        elseBody: elseResult.body
      })
    );

    return owner.#values.rebind(output);
  }

  ifControl(condition: BitValue, control: IfControlBodies): void {
    this.#values.resolve(condition);
    this.#emit(
      createIfControl({
        condition,
        ...(control.hint === undefined ? {} : { hint: control.hint }),
        thenBody: control.thenBody,
        ...(control.elseBody === undefined ? {} : { elseBody: control.elseBody })
      })
    );
  }

  switch<Width extends IntegerWidth>(
    selector: AnyNarrowInteger,
    arms: readonly SwitchArm<NoInfer<Width>>[],
    defaultBuild: BuildInteger<Width>
  ): Integer<Width>;
  switch<Value extends AnyValue>(
    selector: AnyNarrowInteger,
    arms: readonly SwitchValueArm<NoInfer<Value>>[],
    defaultBuild: BuildTypedValue<Value>
  ): Value;
  switch(
    selector: AnyNarrowInteger,
    arms: readonly SwitchValueArm<AnyValue>[],
    defaultBuild: BuildValue
  ): AnyValue {
    this.#values.resolve(selector);

    const defaultResult = this.#childValueResultBody(defaultBuild);
    const cases = arms.map(({ match, build }) => {
      const result = this.#childValueResultBody(build);

      assert(
        sameValueType(result.type, defaultResult.type),
        `switch arm does not match the ${defaultResult.type.kind}[${defaultResult.type.width}] default`
      );
      return {
        matches: [match],
        body: result.body
      };
    });
    this.#assertControlResults(
      [...cases.map((entry) => entry.body), defaultResult.body],
      defaultResult.type
    );

    const output = this.#values.producer(defaultResult.type);
    const owner = this.#emit(
      createSwitchControl({
        selector,
        output,
        cases,
        defaultBody: defaultResult.body
      })
    );

    return owner.#values.rebind(output);
  }

  switchControl(
    selector: AnyNarrowInteger,
    arms: readonly SwitchControlArm[],
    defaultBuild: BuildBody
  ): void {
    for (const [index, arm] of arms.entries()) {
      assert(arm.matches.length > 0, `control-only switch arm ${index} has no matches`);
    }
    this.#values.resolve(selector);

    const cases = arms.map(({ matches, build }) => ({
      matches,
      body: this.#childBody(build)
    }));
    const defaultBody = this.#childBody(defaultBuild);

    this.#emit(
      createSwitchControl({
        selector,
        cases,
        defaultBody
      })
    );
  }

  return(results: readonly AnyValue[]): void {
    const functionResults = this.#functionResults;

    if (functionResults !== undefined) {
      assert(
        results.length === functionResults.length &&
          results.every((value, index) => {
            const expected = functionResults[index];

            return expected !== undefined && sameValueType(valueTypeOf(value), expected);
          }),
        "return values do not match the enclosing function"
      );
    }

    this.#values.resolveAll(results);
    this.#emit(
      createReturnControl({
        source: {
          kind: "values",
          values: results
        }
      })
    );
  }

  loop<const Seeds extends readonly AnyValue[]>(
    seeds: Seeds,
    bodyBuild: (body: RegionBuilder, inputs: LoopInputs<Seeds>) => void,
    options?: LoopOptions
  ): void;
  loop(seeds: readonly AnyValue[], bodyBuild: BuildLoopBody, options: LoopOptions = {}): void {
    this.#values.resolveAll(seeds);

    const body = this.#child(
      options.resourceReadPlacement === undefined
        ? new BufferedRegionNodeSink()
        : new LoopBodySink(this, options.resourceReadPlacement)
    );
    // Carriage is by value type: width alone does not identify a family.
    const carriedTypes = seeds.map((seed) => valueTypeOf(seed));

    body.#loopUpdateTypes = carriedTypes;
    const loopInputs = carriedTypes.map((type) => body.#values.loopInput(type));

    bodyBuild(body, loopInputs);

    this.#emit(
      createLoopControl({
        carried: seeds.map((seed, index) => {
          const loopInput = loopInputs[index];

          assert(loopInput !== undefined, `loop seed ${index} has no input`);
          return { seed, loopInput };
        }),
        body: body.build()
      })
    );
  }

  // The back edge of the enclosing loop; usually sits under an if arm.
  loopContinue(updates: readonly AnyValue[]): void {
    assert(this.#loopUpdateTypes !== undefined, "loopContinue requires an enclosing loop");
    assert(
      updates.length === this.#loopUpdateTypes.length,
      "loopContinue updates do not align with the enclosing loop"
    );
    for (const [index, update] of updates.entries()) {
      const expected = this.#loopUpdateTypes[index];

      assert(
        expected !== undefined && sameValueType(valueTypeOf(update), expected),
        `loop update ${index} does not match the value type carried by the loop`
      );
    }
    this.#values.resolveAll(updates);
    this.#emit(
      createLoopContinueControl({
        updates
      })
    );
  }

  build(): Region {
    return { nodes: this.#sink.nodes(), ...this.#facts() };
  }

  #childBody(build: BuildBody): Region {
    const child = this.child();

    build(child);
    return child.build();
  }

  #childValueResultBody(build: BuildValue): BuiltValueResult {
    const child = this.child();
    const result = build(child);

    child.#values.resolve(result);
    return {
      body: child.#buildResult(result),
      type: valueTypeOf(result)
    };
  }

  #buildResult(result: ValueRef): Region {
    return {
      nodes: this.#sink.nodes(),
      result,
      ...this.#facts()
    };
  }

  // Snapshots, not accumulators: an arm probed for completion may take more
  // nodes before the build that commits it.
  #facts(): Pick<Region, "writes" | "completes"> {
    const nodes = this.#sink.nodes();
    const last = nodes[nodes.length - 1];

    return {
      writes: new Set(this.#writes),
      completes: last?.category === "control" && controlCompletes(last)
    };
  }

  #assertControlResults(bodies: readonly Region[], type: ValueType): void {
    for (const body of bodies) {
      const result = body.result;

      assert(result !== undefined, "value-producing control body has no result");
      assert(
        result.kind === type.kind && result.width === type.width,
        "control result has the wrong type"
      );
    }
  }

  #invocation(target: CallTarget, args: readonly AnyValue[]): Invocation {
    const parameters = target.type.parameters;

    assert(
      args.length === parameters.length,
      `call target expects ${parameters.length} arguments, got ${args.length}`
    );
    for (const [index, value] of args.entries()) {
      const expected = parameters[index];

      assert(expected !== undefined, `call target has no parameter ${index}`);
      assert(
        sameValueType(valueTypeOf(value), expected),
        `call target argument ${index} does not match its declared type`
      );
    }

    this.#values.resolveAll(args);

    return Invocation.create({ target, arguments: args });
  }

  #normalizeResourceAccess<
    Width extends StorageWidth,
    TValueWidth extends StoredIntegerWidth<Width>
  >(access: ResourceAccess<Width, TValueWidth>, base: ValueRef): ResourceAccessNode {
    return {
      effect: access.effect,
      address: {
        base,
        displacement: access.address.displacement
      },
      width: access.width,
      valueWidth: access.valueWidth
    } as ResourceAccessNode;
  }

  // Nested bodies are built before their control is emitted, so the sets this
  // unions are already final.
  #recordWrites(node: RegionNode): void {
    if (node.category === "operation") {
      if (node.kind === "variable.write") {
        this.#writes.add(node.variable);
      }
      return;
    }
    for (const nested of controlRegions(node)) {
      for (const variable of nested.body.writes) {
        this.#writes.add(variable);
      }
    }
  }

  #emit(node: RegionNode): RegionBuilder {
    const redirect = this.#sink.route(node);

    // Writes belong to the frame that retains the node, never to a routing one.
    if (redirect === undefined) {
      this.#recordWrites(node);
    }
    const owner = redirect === undefined ? this : redirect.#emit(node);

    if (buildDefinition.validation) {
      const output = node.category === "operation" ? operationOutput(node) : controlOutput(node);

      if (output !== undefined) {
        assert(
          this.#values.canUseValue(owner.#values, output),
          "node owner is not visible from its origin region"
        );
      }
    }
    return owner;
  }
}

function integerProducer<Width extends IntegerWidth>(
  values: ValueScope,
  width: Width
): Integer<Width>;
function integerProducer(values: ValueScope, width: IntegerWidth): AnyInteger {
  switch (width) {
    case 1:
      return values.producer(IntegerType[1]);
    case 8:
      return values.producer(IntegerType[8]);
    case 16:
      return values.producer(IntegerType[16]);
    case 32:
      return values.producer(IntegerType[32]);
    case 64:
      return values.producer(IntegerType[64]);
  }
}
