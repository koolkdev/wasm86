import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import {
  controlEffects,
  type Control,
  type IfControl,
  type LoopControl,
  type SwitchControl
} from "#compiler/function/control.js";
import type { FunctionBody } from "#compiler/function/body.js";
import type { Invocation } from "#compiler/function/invocation.js";
import { operationEffects, type Operation } from "#compiler/function/operation.js";
import type { Region } from "#compiler/function/region.js";
import type { ValueRef } from "#compiler/function/values.js";
import type { IntegerRef } from "#compiler/function/values/reference.js";
import { Integer, valueTypeOf, type ValueType } from "#compiler/function/values/type.js";
import type { VariableRef } from "#compiler/function/storage.js";
import type { BlockId, CloseEmit, SiteId, WasmBody } from "#compiler/wasm/function/body.js";
import { toWasmValueType, wasmIntegerWidth } from "#compiler/wasm/type-lowering.js";
import { isWasmIntegerType, wasmIntegerTypeWidth } from "#wasm/types.js";
import { WasmValuesBuilder } from "#compiler/wasm/function/values/builder.js";
import {
  joinRequiredBits,
  unknownRequiredBits,
  zeroExtendedRequiredBits,
  type RequiredBits
} from "#compiler/wasm/function/values/integer/required-bits.js";
import type { WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { validateFunction } from "#compiler/function/validate.js";
import { WasmBodyBuilder } from "./body-builder.js";
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

type CloseSpec = Readonly<{
  emit: CloseEmit;
  // Sibling arms whose completion, together with this one's, seals the join.
  seal: readonly BlockId[] | undefined;
}>;

export function lowerWasmFunction(fn: FunctionBody): WasmBody {
  if (buildDefinition.validation) {
    validateFunction(fn);
  }
  const builder = new WasmValuesBuilder();
  const values = new ValueLowerer(fn.values, builder);
  const parameters = fn.parameters.map((parameter) => values.lower(parameter));

  return new FunctionLowerer(values, fn.type.results).lower(fn.entry, parameters.length);
}

const entryClose: CloseSpec = { emit: "none", seal: undefined };

// One walk with two moments: a control's site is recorded before its arms, and
// its event is written after them, into the slot the site reserved.
class FunctionLowerer {
  readonly #body = new WasmBodyBuilder();
  readonly #values: ValueLowerer;
  readonly #functionResults: readonly ValueType[];

  constructor(values: ValueLowerer, functionResults: readonly ValueType[]) {
    this.#values = values;
    this.#functionResults = functionResults;
  }

  lower(entry: Region, parameterCount: number): WasmBody {
    this.#region(
      entry,
      this.#body.openBlock(undefined, undefined, 0, false, 0),
      entryClose,
      new Map(),
      0
    );
    const { graph, facts } = this.#values.wasm.finish();

    return this.#body.finish(parameterCount, graph, facts);
  }

  #region(
    region: Region,
    block: BlockId,
    close: CloseSpec,
    entryBounds: VariableBounds,
    loopDepth: number,
    loopArity?: number,
    loopWrites: readonly VariableWrites[] = []
  ): MutableVariableBounds | undefined {
    let fallthroughBounds: MutableVariableBounds | undefined = new Map(entryBounds);

    for (const [nodeIndex, node] of region.nodes.entries()) {
      assert(fallthroughBounds !== undefined, "region has nodes after a terminal control");

      if (node.category === "operation") {
        const site = this.#body.addSite(block, nodeIndex, operationEffects(node));

        this.#operation(node, site, fallthroughBounds, loopDepth, loopWrites);
        continue;
      }
      const site = this.#body.addSite(block, nodeIndex, controlEffects(node));

      fallthroughBounds = this.#control(
        node,
        site,
        block,
        fallthroughBounds,
        loopDepth,
        loopArity,
        loopWrites
      );
    }
    const closeSite = this.#body.addSite(block, region.nodes.length);
    const result = region.result === undefined ? undefined : this.#values.lower(region.result);

    this.#body.closeBlock(block, closeSite, region.completes);
    this.#body.writeEvent(closeSite, {
      kind: "close",
      block,
      result,
      emit: close.emit,
      seal:
        close.seal !== undefined &&
        region.completes &&
        close.seal.every((arm) => this.#body.blockCompletes(arm))
    });
    return fallthroughBounds;
  }

  #operation(
    operation: Operation,
    site: SiteId,
    bounds: MutableVariableBounds,
    loopDepth: number,
    loopWrites: readonly VariableWrites[]
  ): void {
    this.#body.recordOperationSite(site);
    switch (operation.kind) {
      case "resource.read": {
        const { source } = operation;
        const address = this.#values.lower(source.address.base);
        const output = this.#operationOutput(
          Integer[source.valueWidth],
          loopDepth,
          zeroExtendedRequiredBits(32, source.valueWidth)
        );

        this.#values.bind(operation.output, output);
        assert(address < output, `Wasm operation input ${address} must precede output ${output}`);
        this.#body.recordProducer(site, output);
        this.#body.writeEvent(site, {
          kind: "load",
          width: source.width,
          effect: source.effect,
          displacement: source.address.displacement,
          address,
          output
        });
        return;
      }
      case "resource.write": {
        const { destination } = operation;
        // Preserve lowering order even though Wasm consumes address first.
        const value =
          destination.valueWidth < destination.width
            ? this.#values.normalize(operation.value, "unsigned")
            : this.#values.lower(operation.value);
        const address = this.#values.lower(destination.address.base);

        this.#body.writeEvent(site, {
          kind: "store",
          width: destination.width,
          effect: destination.effect,
          displacement: destination.address.displacement,
          address,
          value
        });
        return;
      }
      case "variable.read": {
        const readBounds =
          bounds.get(operation.variable) ??
          unknownRequiredBits(wasmIntegerWidth(operation.variable.width));
        const output = this.#operationOutput(
          Integer[operation.variable.width],
          loopDepth,
          readBounds
        );

        this.#values.bind(operation.output, output);
        this.#body.recordProducer(site, output);
        this.#body.writeEvent(site, {
          kind: "variableRead",
          variable: operation.variable,
          output
        });
        return;
      }
      case "variable.write": {
        const value = this.#values.lower(operation.value);
        const valueBounds = this.#values.wasm.requiredBits(value);

        bounds.set(operation.variable, valueBounds);
        for (const writes of loopWrites) {
          recordVariableWrite(writes, operation.variable, valueBounds);
        }
        this.#body.writeEvent(site, {
          kind: "variableWrite",
          variable: operation.variable,
          value,
          seed: operation.initialization === "seed"
        });
        return;
      }
      case "call": {
        const { target } = operation.invocation;
        const operands = this.#invocation(operation.invocation);
        const resultType = target.type.results[0];
        const output =
          resultType === undefined
            ? undefined
            : this.#operationOutput(resultType, loopDepth, this.#functionValueBounds(resultType));

        if (operation.output !== undefined) {
          assert(output !== undefined, "lowered call has no output");
          this.#values.bind(operation.output, output);
        }
        if (output !== undefined) {
          for (const operand of operands) {
            assert(
              operand < output,
              `Wasm operation input ${operand} must precede output ${output}`
            );
          }
          this.#body.recordProducer(site, output);
        }
        this.#body.writeEvent(site, { kind: "call", target, operands, output });
        return;
      }
    }
  }

  #control(
    control: Control,
    site: SiteId,
    block: BlockId,
    bounds: VariableBounds,
    loopDepth: number,
    loopArity: number | undefined,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds | undefined {
    switch (control.kind) {
      case "if":
        return this.#if(control, site, block, bounds, loopDepth, loopArity, loopWrites);
      case "switch":
        return this.#switch(control, site, block, bounds, loopDepth, loopArity, loopWrites);
      case "loop":
        return this.#loop(control, site, block, bounds, loopDepth, loopWrites);
      case "loopContinue": {
        assert(loopArity !== undefined, "loop continue is outside a loop");
        assert(
          control.updates.length === loopArity,
          "loop continue update count does not match its loop"
        );
        this.#body.writeEvent(site, {
          kind: "loopContinue",
          updates: control.updates.map((update) => this.#values.lower(update))
        });
        return undefined;
      }
      case "return": {
        const { source } = control;

        this.#body.writeEvent(
          site,
          source.kind === "values"
            ? {
                kind: "return",
                operands: source.values.map((value, index) => {
                  const type = this.#functionResults[index];

                  assert(type !== undefined, `function has no result ${index}`);
                  return this.#functionValue(value, type);
                })
              }
            : {
                kind: "returnCall",
                target: source.invocation.target,
                operands: this.#invocation(source.invocation)
              }
        );
        return undefined;
      }
    }
  }

  #if(
    control: IfControl,
    site: SiteId,
    block: BlockId,
    bounds: VariableBounds,
    loopDepth: number,
    loopArity: number | undefined,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds | undefined {
    const thenBlock = this.#body.openBlock(block, site, 0, false, loopDepth);
    const thenBounds = this.#region(
      control.thenBody,
      thenBlock,
      { emit: control.elseBody === undefined ? "end" : "else", seal: undefined },
      bounds,
      loopDepth,
      loopArity,
      loopWrites
    );
    let elseBlock: BlockId | undefined;
    let elseBounds: MutableVariableBounds | undefined;

    if (control.elseBody !== undefined) {
      elseBlock = this.#body.openBlock(block, site, 1, false, loopDepth);
      elseBounds = this.#region(
        control.elseBody,
        elseBlock,
        { emit: "end", seal: [thenBlock] },
        bounds,
        loopDepth,
        loopArity,
        loopWrites
      );
    }
    const output =
      control.output === undefined
        ? undefined
        : this.#joinOutput(control.output, loopDepth, [
            this.#regionResult(control.thenBody),
            this.#regionResult(control.elseBody)
          ]);

    if (control.output !== undefined) {
      assert(output !== undefined, "lowered value-producing if has no output");
      this.#values.bind(control.output, output);
    }
    const condition = this.#values.condition(control.condition);
    const arms = elseBlock === undefined ? [thenBlock] : [thenBlock, elseBlock];

    this.#body.writeEvent(site, { kind: "if", hint: control.hint, arms, condition, output });
    this.#body.recordJoinProducer(output, site, arms);
    return joinFallthroughBounds(
      bounds,
      thenBounds,
      control.elseBody === undefined ? bounds : elseBounds
    );
  }

  #switch(
    control: SwitchControl,
    site: SiteId,
    block: BlockId,
    bounds: VariableBounds,
    loopDepth: number,
    loopArity: number | undefined,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds | undefined {
    const cases = control.cases.map((entry, index): SwitchArm => {
      const caseBlock = this.#body.openBlock(block, site, index, false, loopDepth);

      return {
        block: caseBlock,
        bounds: this.#region(
          entry.body,
          caseBlock,
          { emit: "endArm", seal: undefined },
          bounds,
          loopDepth,
          loopArity,
          loopWrites
        )
      };
    });
    const caseBlocks = cases.map((entry) => entry.block);
    const defaultBlock = this.#body.openBlock(block, site, control.cases.length, false, loopDepth);
    const defaultBounds = this.#region(
      control.defaultBody,
      defaultBlock,
      { emit: "end", seal: caseBlocks },
      bounds,
      loopDepth,
      loopArity,
      loopWrites
    );
    const output =
      control.output === undefined
        ? undefined
        : this.#joinOutput(control.output, loopDepth, [
            ...control.cases.map((entry) => this.#regionResult(entry.body)),
            this.#regionResult(control.defaultBody)
          ]);

    if (control.output !== undefined) {
      assert(output !== undefined, "lowered value-producing switch has no output");
      this.#values.bind(control.output, output);
    }
    const selector = this.#values.normalize(control.selector, "unsigned");

    this.#body.writeEvent(site, {
      kind: "switch",
      caseMatches: control.cases.map((entry) => entry.matches),
      selector,
      output
    });
    this.#body.recordJoinProducer(output, site, [...caseBlocks, defaultBlock]);
    return joinFallthroughBounds(bounds, ...cases.map((entry) => entry.bounds), defaultBounds);
  }

  #loop(
    control: LoopControl,
    site: SiteId,
    block: BlockId,
    bounds: VariableBounds,
    loopDepth: number,
    loopWrites: readonly VariableWrites[]
  ): MutableVariableBounds {
    // Loops are the exception to lower-after-arms: seeds and loop inputs are
    // lowered before the body they carry into.
    const carried = control.carried.map(({ seed, loopInput }) => ({
      seed: this.#values.lower(seed),
      loopInput: this.#loopInput(loopInput, loopDepth + 1)
    }));
    const writtenVariables = control.body.writes;
    const bodyEntryBounds = new Map(bounds);

    // A prior iteration may have written any variable touched by the loop.
    for (const variable of writtenVariables) {
      if (bodyEntryBounds.has(variable)) {
        bodyEntryBounds.set(variable, unknownRequiredBits(wasmIntegerWidth(variable.width)));
      }
    }
    const writes: VariableWrites = new Map();

    this.#region(
      control.body,
      this.#body.openBlock(block, site, 0, true, loopDepth),
      { emit: "end", seal: undefined },
      bodyEntryBounds,
      loopDepth + 1,
      carried.length,
      [...loopWrites, writes]
    );
    const exitBounds = new Map(bounds);

    for (const variable of writtenVariables) {
      const entry = bounds.get(variable);

      if (entry === undefined) {
        continue;
      }
      const written = writes.get(variable);

      // The loop can exit with either its incoming value or a written one.
      exitBounds.set(
        variable,
        written === undefined
          ? entry
          : joinRequiredBits(wasmIntegerWidth(variable.width), [entry, written])
      );
    }
    this.#body.writeEvent(site, {
      kind: "loop",
      seeds: carried.map((value) => value.seed),
      loopInputs: carried.map((value) => value.loopInput)
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
    // Function construction and validation keep each value paired with this
    // declared type; Float has no sub-32-bit branch.
    return type.width < 32
      ? this.#values.normalize(value as IntegerRef, "unsigned")
      : this.#values.lower(value);
  }

  #functionValueBounds(type: ValueType): RequiredBits | undefined {
    return type.width < 32 ? zeroExtendedRequiredBits(32, type.width) : undefined;
  }

  #operationOutput(type: ValueType, requiredLoopDepth: number, bits?: RequiredBits): WasmValueId {
    return this.#values.wasm.producerOutput(toWasmValueType(type), requiredLoopDepth, bits);
  }

  #joinOutput(
    irValue: ValueRef,
    requiredLoopDepth: number,
    inputs: readonly JoinInput[]
  ): WasmValueId {
    const type = toWasmValueType(valueTypeOf(irValue));

    // Only an integer join has arm bounds to join.
    if (!isWasmIntegerType(type)) {
      return this.#values.wasm.producerOutput(type, requiredLoopDepth);
    }
    return this.#values.wasm.producerOutput(
      type,
      requiredLoopDepth,
      joinRequiredBits(
        wasmIntegerTypeWidth(type),
        inputs
          .filter((input) => !this.#values.isUnreachable(input.source))
          .map((input) => this.#values.wasm.requiredBits(input.wasm))
      )
    );
  }

  #loopInput(irValue: ValueRef, requiredLoopDepth: number): WasmValueId {
    const input = this.#values.wasm.loopInput(
      toWasmValueType(valueTypeOf(irValue)),
      requiredLoopDepth
    );

    this.#values.bind(irValue, input);
    return input;
  }

  #regionResult(region: Region | undefined): JoinInput {
    assert(region !== undefined, "value-producing control has no arm");
    const source = region.result;

    assert(source !== undefined, "value-producing control arm has no result");
    return { source, wasm: this.#values.lower(source) };
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
    joined.set(
      variable,
      joinRequiredBits(
        wasmIntegerWidth(variable.width),
        reachable.map(
          (exit) => exit.get(variable) ?? unknownRequiredBits(wasmIntegerWidth(variable.width))
        )
      )
    );
  }
  return joined;
}

function recordVariableWrite(
  writes: VariableWrites,
  variable: VariableRef,
  bounds: RequiredBits
): void {
  const recorded = writes.get(variable);

  writes.set(
    variable,
    recorded === undefined
      ? bounds
      : joinRequiredBits(wasmIntegerWidth(variable.width), [recorded, bounds])
  );
}
