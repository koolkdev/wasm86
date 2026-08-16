import { assert } from "#common/assert.js";
import type { Control, IfControl, LoopControl, SwitchControl } from "#compiler/function/control.js";
import type { FunctionBody } from "#compiler/function/body.js";
import type { Invocation } from "#compiler/function/invocation.js";
import type { Operation } from "#compiler/function/operation.js";
import type { Region } from "#compiler/function/region.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { ValueType } from "#compiler/function/values/type.js";
import type { IntegerRef } from "#compiler/function/values/expression.js";
import { valueTypeOf, type ValueRef } from "#compiler/function/values.js";
import {
  blockId,
  siteId,
  type BlockId,
  type BodyEvent,
  type BodySite,
  type SiteId,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import {
  joinRequiredBits,
  unknownRequiredBits,
  zeroExtendedRequiredBits,
  type RequiredBits
} from "#compiler/wasm/function/values/integer/required-bits.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { toWasmValueType, wasmIntegerType, wasmIntegerWidth } from "#compiler/wasm/type-mapping.js";
import { convertIntegerRepresentation } from "./integer/operations.js";
import { ValueLowerer } from "./values.js";

type VariableBounds = ReadonlyMap<VariableRef, RequiredBits>;
type MutableVariableBounds = Map<VariableRef, RequiredBits>;
type VariableWrites = Map<VariableRef, RequiredBits>;

type JoinInput = Readonly<{
  source: ValueRef;
  wasm: WasmValueId;
}>;

type SwitchArm = Readonly<{
  block: BlockId;
  bounds: MutableVariableBounds | undefined;
}>;

type SiteDraft = {
  readonly block: BlockId;
  event: BodyEvent | undefined;
};

export function lowerWasmFunction(fn: FunctionBody): WasmBody {
  const wasm = new WasmValuesBuilder();
  const values = new ValueLowerer(fn.values, wasm);

  for (const parameter of fn.parameters) {
    values.lower(parameter);
  }
  return new FunctionLowerer(values, fn.type.results).lower(fn.entry, fn.parameters.length);
}

// The traversal reserves a control site before lowering its children, then
// fills that site's event after their results and target values are known.
class FunctionLowerer {
  readonly #sites: SiteDraft[] = [];
  #blockCount = 0;
  readonly #values: ValueLowerer;
  readonly #functionResults: readonly ValueType[];

  constructor(values: ValueLowerer, functionResults: readonly ValueType[]) {
    this.#values = values;
    this.#functionResults = functionResults;
  }

  lower(entry: Region, parameterCount: number): WasmBody {
    const entryBlock = this.#openBlock();

    this.#region(entry, entryBlock, new Map());
    const sites = this.#sites.map(({ block, event }): BodySite => {
      assert(event !== undefined, "lowered site has no event");
      return { block, event };
    });

    return {
      parameterCount,
      values: this.#values.wasm.finish(),
      entryBlock,
      sites
    };
  }

  #region(
    region: Region,
    block: BlockId,
    entryBounds: VariableBounds,
    loopArity?: number,
    loopWrites: readonly VariableWrites[] = []
  ): MutableVariableBounds | undefined {
    let fallthroughBounds: MutableVariableBounds | undefined = new Map(entryBounds);

    for (const node of region.nodes) {
      assert(fallthroughBounds !== undefined, "region has nodes after a terminal control");
      const site = this.#reserveSite(block);

      if (node.category === "operation") {
        this.#writeSite(site, this.#operation(node, fallthroughBounds, loopWrites));
      } else {
        fallthroughBounds = this.#control(node, site, fallthroughBounds, loopArity, loopWrites);
      }
    }

    assert(
      (fallthroughBounds !== undefined) === region.fallsThrough,
      "region flow does not match its terminal control"
    );
    const result = region.result === undefined ? undefined : this.#values.lower(region.result);

    this.#endBlock(block, result, region.fallsThrough);
    return fallthroughBounds;
  }

  #operation(
    operation: Operation,
    bounds: MutableVariableBounds,
    loopWrites: readonly VariableWrites[]
  ): BodyEvent {
    switch (operation.kind) {
      case "resource.read": {
        const { source } = operation;
        const address = this.#values.lower(source.address.base);
        const storageType = wasmIntegerType(source.storageWidth);
        const logicalType = wasmIntegerType(source.valueWidth);
        const carrier = this.#values.wasm.producerOutput(
          storageType,
          zeroExtendedRequiredBits(wasmIntegerWidth(source.storageWidth), source.valueWidth)
        );
        const output = convertIntegerRepresentation(this.#values.wasm, carrier, logicalType);

        this.#values.bind(operation.output, output);
        return {
          kind: "load",
          storageWidth: source.storageWidth,
          effect: source.effect,
          displacement: source.address.displacement,
          address,
          output: carrier
        };
      }
      case "resource.write": {
        const { destination } = operation;
        const storageType = wasmIntegerType(destination.storageWidth);
        // Preserve value discovery order even though Wasm consumes the address first.
        const logicalValue =
          destination.valueWidth < destination.storageWidth
            ? this.#values.normalize(operation.value, "unsigned")
            : this.#values.lower(operation.value);
        const value = convertIntegerRepresentation(this.#values.wasm, logicalValue, storageType);
        const address = this.#values.lower(destination.address.base);

        return {
          kind: "store",
          storageWidth: destination.storageWidth,
          effect: destination.effect,
          displacement: destination.address.displacement,
          address,
          value
        };
      }
      case "variable.read": {
        const bits = this.#variableReadBits(operation.variable, bounds);
        const output = this.#producerOutput(operation.variable.type, bits);

        this.#values.bind(operation.output, output);
        return { kind: "variableRead", variable: operation.variable, output };
      }
      case "variable.write": {
        const value = this.#values.lower(operation.value);

        if (operation.variable.type.kind === "integer") {
          const valueBounds = this.#values.wasm.requiredBits(value);

          bounds.set(operation.variable, valueBounds);
          for (const writes of loopWrites) {
            recordVariableWrite(
              writes,
              operation.variable,
              operation.variable.type.width,
              valueBounds
            );
          }
        }
        return {
          kind: "variableWrite",
          variable: operation.variable,
          value,
          initialization: operation.initialization
        };
      }
      case "call": {
        const { target } = operation.invocation;
        const operands = this.#invocation(operation.invocation);
        const resultType = target.type.results[0];
        const output =
          resultType === undefined
            ? undefined
            : this.#producerOutput(
                resultType,
                resultType.kind === "integer" && resultType.width < 32
                  ? zeroExtendedRequiredBits(32, resultType.width)
                  : undefined
              );

        if (operation.output !== undefined) {
          assert(output !== undefined, "lowered call has no output");
          this.#values.bind(operation.output, output);
        }
        return { kind: "call", target, operands, output };
      }
    }
  }

  #control(
    control: Control,
    site: SiteId,
    bounds: VariableBounds,
    loopArity: number | undefined,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds | undefined {
    switch (control.kind) {
      case "if":
        return this.#if(control, site, bounds, loopArity, loopWrites);
      case "switch":
        return this.#switch(control, site, bounds, loopArity, loopWrites);
      case "loop":
        return this.#loop(control, site, bounds, loopWrites);
      case "loopContinue":
        assert(loopArity !== undefined, "loop continue is outside a loop");
        assert(
          control.updates.length === loopArity,
          "loop continue update count does not match its loop"
        );
        this.#writeSite(site, {
          kind: "loopContinue",
          updates: control.updates.map((update) => this.#values.lower(update))
        });
        return undefined;
      case "return":
        this.#writeSite(
          site,
          control.source.kind === "values"
            ? {
                kind: "return",
                operands: control.source.values.map((value, index) => {
                  const type = this.#functionResults[index];

                  assert(type !== undefined, `function has no result ${index}`);
                  return this.#functionValue(value, type);
                })
              }
            : {
                kind: "returnCall",
                target: control.source.invocation.target,
                operands: this.#invocation(control.source.invocation)
              }
        );
        return undefined;
    }
  }

  #if(
    control: IfControl,
    site: SiteId,
    bounds: VariableBounds,
    loopArity: number | undefined,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds | undefined {
    const thenBlock = this.#openBlock();
    const thenBounds = this.#region(control.thenBody, thenBlock, bounds, loopArity, loopWrites);
    let elseBlock: BlockId | undefined;
    let elseBounds: MutableVariableBounds | undefined;

    if (control.elseBody !== undefined) {
      elseBlock = this.#openBlock();
      elseBounds = this.#region(control.elseBody, elseBlock, bounds, loopArity, loopWrites);
    }
    const arms = elseBlock === undefined ? [thenBlock] : [thenBlock, elseBlock];
    const output =
      control.output === undefined
        ? undefined
        : this.#joinOutput(control.output, [
            this.#regionResult(control.thenBody),
            this.#regionResult(control.elseBody)
          ]);

    if (control.output !== undefined) {
      assert(output !== undefined, "lowered value-producing if has no output");
      this.#values.bind(control.output, output);
    }
    this.#writeSite(site, {
      kind: "if",
      hint: control.hint,
      condition: this.#values.condition(control.condition),
      arms,
      output
    });
    return joinFallthroughBounds(
      bounds,
      thenBounds,
      control.elseBody === undefined ? bounds : elseBounds
    );
  }

  #switch(
    control: SwitchControl,
    site: SiteId,
    bounds: VariableBounds,
    loopArity: number | undefined,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds | undefined {
    const cases = control.cases.map((entry): SwitchArm => {
      const caseBlock = this.#openBlock();

      return {
        block: caseBlock,
        bounds: this.#region(entry.body, caseBlock, bounds, loopArity, loopWrites)
      };
    });
    const defaultBlock = this.#openBlock();
    const defaultBounds = this.#region(
      control.defaultBody,
      defaultBlock,
      bounds,
      loopArity,
      loopWrites
    );
    const output =
      control.output === undefined
        ? undefined
        : this.#joinOutput(control.output, [
            ...control.cases.map((entry) => this.#regionResult(entry.body)),
            this.#regionResult(control.defaultBody)
          ]);

    if (control.output !== undefined) {
      assert(output !== undefined, "lowered value-producing switch has no output");
      this.#values.bind(control.output, output);
    }
    this.#writeSite(site, {
      kind: "switch",
      caseMatches: control.cases.map((entry) => entry.matches),
      selector: this.#values.normalize(control.selector, "unsigned"),
      arms: [...cases.map((entry) => entry.block), defaultBlock],
      output
    });
    return joinFallthroughBounds(bounds, ...cases.map((entry) => entry.bounds), defaultBounds);
  }

  #loop(
    control: LoopControl,
    site: SiteId,
    bounds: VariableBounds,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds {
    const carried = control.carried.map(({ seed, loopInput }) => ({
      seed: this.#values.lower(seed),
      input: this.#loopInput(loopInput)
    }));
    const bodyEntryBounds = new Map(bounds);

    for (const variable of control.body.writtenVariables) {
      if (variable.type.kind === "integer" && bodyEntryBounds.has(variable)) {
        bodyEntryBounds.set(variable, unknownRequiredBits(wasmIntegerWidth(variable.type.width)));
      }
    }
    const writes: VariableWrites = new Map();
    const body = this.#openBlock();

    this.#region(control.body, body, bodyEntryBounds, carried.length, [...loopWrites, writes]);
    const exitBounds = new Map(bounds);

    for (const variable of control.body.writtenVariables) {
      if (variable.type.kind !== "integer") {
        continue;
      }
      const entry = bounds.get(variable);

      if (entry === undefined) {
        continue;
      }
      const written = writes.get(variable);

      exitBounds.set(
        variable,
        written === undefined
          ? entry
          : joinRequiredBits(wasmIntegerWidth(variable.type.width), [entry, written])
      );
    }
    this.#writeSite(site, {
      kind: "loop",
      body,
      seeds: carried.map((value) => value.seed),
      inputs: carried.map((value) => value.input)
    });
    return exitBounds;
  }

  #invocation(invocation: Invocation): readonly WasmValueId[] {
    return invocation.arguments.map((input, index) => {
      const type = invocation.target.type.parameters[index];

      assert(type !== undefined, `call target has no parameter ${index}`);
      return this.#functionValue(input, type);
    });
  }

  #functionValue(value: ValueRef, type: ValueType): WasmValueId {
    return type.kind === "integer" && type.width < 32
      ? this.#values.normalize(value as IntegerRef, "unsigned")
      : this.#values.lower(value);
  }

  #producerOutput(type: ValueType, bits?: RequiredBits): WasmValueId {
    return this.#values.wasm.producerOutput(toWasmValueType(type), bits);
  }

  #joinOutput(value: ValueRef, inputs: readonly JoinInput[]): WasmValueId {
    const type = valueTypeOf(value);

    return this.#producerOutput(
      type,
      type.kind === "integer"
        ? joinRequiredBits(
            wasmIntegerWidth(type.width),
            inputs
              .filter((input) => !this.#values.isUnreachable(input.source))
              .map((input) => this.#values.wasm.requiredBits(input.wasm))
          )
        : undefined
    );
  }

  #loopInput(value: ValueRef): WasmValueId {
    const input = this.#values.wasm.loopInput(toWasmValueType(valueTypeOf(value)));

    this.#values.bind(value, input);
    return input;
  }

  #regionResult(region: Region | undefined): JoinInput {
    assert(region !== undefined, "value-producing control has no arm");
    const source = region.result;

    assert(source !== undefined, "value-producing control arm has no result");
    return { source, wasm: this.#values.lower(source) };
  }

  #variableReadBits(variable: VariableRef, bounds: VariableBounds): RequiredBits | undefined {
    const type = variable.type;

    if (type.kind === "float") {
      return undefined;
    }
    return bounds.get(variable) ?? unknownRequiredBits(wasmIntegerWidth(type.width));
  }

  #openBlock(): BlockId {
    const block = blockId(this.#blockCount);

    this.#blockCount += 1;
    return block;
  }

  #reserveSite(block: BlockId): SiteId {
    const site = siteId(this.#sites.length);

    assert(block < this.#blockCount, `unknown lowered block ${block}`);
    this.#sites.push({ block, event: undefined });
    return site;
  }

  #endBlock(block: BlockId, result: WasmValueId | undefined, fallsThrough: boolean): void {
    assert(block < this.#blockCount, `unknown lowered block ${block}`);
    this.#sites.push({ block, event: { kind: "end", result, fallsThrough } });
  }

  #writeSite(site: SiteId, event: BodyEvent): void {
    const draft = this.#sites[site];

    assert(draft !== undefined, `unknown lowered site ${site}`);
    assert(draft.event === undefined, `lowered site ${site} already has an event`);
    draft.event = event;
  }
}

function joinFallthroughBounds(
  visibleBounds: VariableBounds,
  ...exits: (VariableBounds | undefined)[]
): MutableVariableBounds | undefined {
  const reachable = exits.filter((exit): exit is VariableBounds => exit !== undefined);

  if (reachable.length === 0) {
    return undefined;
  }
  const joined: MutableVariableBounds = new Map();

  for (const variable of visibleBounds.keys()) {
    assert(variable.type.kind === "integer", "float variable has integer bounds");
    joined.set(
      variable,
      joinRequiredBits(
        wasmIntegerWidth(variable.type.width),
        reachable.map(
          (exit) => exit.get(variable) ?? unknownRequiredBits(wasmIntegerWidth(variable.type.width))
        )
      )
    );
  }
  return joined;
}

function recordVariableWrite(
  writes: VariableWrites,
  variable: VariableRef,
  width: 1 | 8 | 16 | 32 | 64,
  bounds: RequiredBits
): void {
  const recorded = writes.get(variable);

  writes.set(
    variable,
    recorded === undefined ? bounds : joinRequiredBits(wasmIntegerWidth(width), [recorded, bounds])
  );
}
