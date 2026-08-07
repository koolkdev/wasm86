import { assert } from "#common/assert.js";
import {
  controlCompletes,
  controlEffects,
  controlOperands,
  controlOutput,
  controlRegions,
  type Control,
  type ControlRegion
} from "#compiler/function/control.js";
import type { FunctionType, ValueType } from "#compiler/function/type.js";
import type { Invocation } from "#compiler/function/invocation.js";
import {
  operationEffects,
  operationOperands,
  operationOutput,
  operationResultType,
  type Operation
} from "#compiler/function/operation.js";
import type { ValueRef } from "#compiler/function/values.js";
import type { VariableRef } from "#compiler/function/storage.js";
import { sameValueType, valueTypeOf } from "#compiler/function/values/type.js";
import type { ValueRecord, ValueSlot } from "#compiler/function/values/record.js";
import type { FunctionValues } from "#compiler/function/values/scope.js";
import type { Region, RegionNode } from "../region.js";
import { validateResourceOperation, validateStorageEffectRanges } from "./resource.js";

export type ValidationFunction = Readonly<{
  entry: Region;
  type: FunctionType;
  parameters: readonly ValueRef[];
  values: FunctionValues;
}>;

type RegionNodeSite = Readonly<{
  body: Region;
  nodeIndex: number;
  path: string;
}>;

type RegionOwner = Readonly<{
  body: Region;
  nodeIndex: number;
}>;

type LoopScope = Extract<ControlRegion["scope"], { kind: "loop" }>;

type RegionValidationContext = Readonly<{
  path: string;
  ownerOutput: ValueRef | undefined;
  enclosingLoop: LoopScope | undefined;
}>;

export function validateFunction(fn: ValidationFunction): void {
  new FunctionValidator(fn).validate();
}

// Validation has two phases. Indexing establishes the unique body tree and all
// scoped definitions; the validation walk can then reject forward and escaping
// uses without depending on traversal order.
class FunctionValidator {
  readonly #function: ValidationFunction;
  readonly #values: FunctionValues;
  readonly #regionOwners = new Map<Region, RegionOwner | null>();
  readonly #producers = new Map<ValueSlot, RegionNodeSite>();
  readonly #loopInputs = new Map<ValueSlot, Region>();
  readonly #variableSeeds = new Map<VariableRef, RegionNodeSite>();
  readonly #parameterSlots = new Set<ValueSlot>();

  constructor(fn: ValidationFunction) {
    this.#function = fn;
    this.#values = fn.values;
    this.#regionOwners.set(fn.entry, null);
  }

  validate(): void {
    this.#validateParameters();
    this.#indexBody(this.#function.entry, "entry");
    this.#assertEveryProducerOutputHasProducer();
    this.#validateRegion(this.#function.entry, {
      path: "entry",
      ownerOutput: undefined,
      enclosingLoop: undefined
    });
    assert(this.#function.entry.completes, "function entry does not complete");
  }

  // Phase 1 indexes producers and lexical definitions before checking uses.
  #indexBody(body: Region, path: string): void {
    for (const [nodeIndex, node] of body.nodes.entries()) {
      const site: RegionNodeSite = {
        body,
        nodeIndex,
        path: `${path}.${node.kind}[${nodeIndex}]`
      };

      this.#indexNodeDefinitions(node, site);
    }
  }

  #indexNodeDefinitions(node: RegionNode, site: RegionNodeSite): void {
    if (node.category === "operation") {
      validateStorageEffectRanges(operationEffects(node), site.path);
      this.#validateOperationDeclaration(node, site.path);
      this.#indexOperationOutputs(node, site);
      this.#indexVariableDefinition(node, site);
      return;
    }

    validateStorageEffectRanges(controlEffects(node), site.path);
    this.#validateControl(node, site.path);
    this.#indexControlOutputs(node, site);

    for (const nested of controlRegions(node)) {
      this.#indexScopedInputs(nested, site);
      this.#indexNestedBody(nested.body, site, `${site.path}.${nested.role}`);
    }
  }

  #validateOperationDeclaration(operation: Operation, path: string): void {
    const output = operationOutput(operation);
    const resultType = operationResultType(operation);

    assert(
      (output === undefined) === (resultType === undefined),
      `${path} operation result and output do not align`
    );
    if (output !== undefined && resultType !== undefined) {
      const outputType = valueTypeOf(output);

      assert(
        sameValueType(outputType, resultType),
        `${path} output has the wrong value type: ${typeName(outputType)} for a ${typeName(resultType)} result`
      );
    }

    switch (operation.kind) {
      case "call":
      case "variable.read":
      case "variable.write":
        break;
      case "resource.read":
      case "resource.write":
        validateResourceOperation(operation, path);
        break;
    }
    this.#validateOperationWidths(operation, path);
    if (operation.kind === "call") {
      this.#validateInvocation(operation.invocation, path);
    }
  }

  #validateOperationWidths(operation: Operation, path: string): void {
    switch (operation.kind) {
      case "call":
      case "variable.read":
        return;
      case "variable.write": {
        const { width } = operation.variable;

        assert(operation.value.width === width, `${path} variable value must be ${width} bits`);
        return;
      }
      case "resource.read":
        assert(
          operation.source.valueWidth <= operation.source.width,
          `${path} resource value width cannot exceed its transfer width`
        );
        assert(
          operation.source.address.base.width === 32,
          `${path} resource address must be 32 bits`
        );
        return;
      case "resource.write":
        assert(
          operation.destination.valueWidth <= operation.destination.width,
          `${path} resource value width cannot exceed its transfer width`
        );
        assert(
          operation.destination.address.base.width === 32,
          `${path} resource address must be 32 bits`
        );
        assert(
          operation.value.width === operation.destination.valueWidth,
          `${path} resource value must be ${operation.destination.valueWidth} bits`
        );
        return;
    }
  }

  #validateControl(control: Control, path: string): void {
    if (control.kind !== "loop") {
      return;
    }

    for (const [index, carried] of control.carried.entries()) {
      const seedType = valueTypeOf(carried.seed);
      const inputType = valueTypeOf(carried.loopInput);

      assert(
        sameValueType(seedType, inputType),
        `${path} carried value ${index} value types do not match: seed ${typeName(seedType)}, input ${typeName(inputType)}`
      );
    }
  }

  #indexOperationOutputs(operation: Operation, site: RegionNodeSite): void {
    const output = operationOutput(operation);

    if (output !== undefined) {
      this.#recordProducer(output, site);
    }
  }

  #indexControlOutputs(control: Control, site: RegionNodeSite): void {
    const output = controlOutput(control);

    if (output !== undefined) {
      this.#recordProducer(output, site);
    }
  }

  #indexNestedBody(body: Region, owner: RegionNodeSite, path: string): void {
    this.#recordRegionOwner(body, owner, path);
    this.#indexBody(body, path);
  }

  #recordRegionOwner(body: Region, owner: RegionNodeSite, path: string): void {
    assert(
      !this.#regionOwners.has(body),
      `${path} reuses a Region object that already has an owner`
    );
    this.#regionOwners.set(body, {
      body: owner.body,
      nodeIndex: owner.nodeIndex
    });
  }

  // The seed write is the variable's declaration: the body holding it is the
  // variable's lexical scope, so scoping needs no identity beyond this site.
  #indexVariableDefinition(operation: Operation, site: RegionNodeSite): void {
    if (operation.kind !== "variable.write" || operation.initialization !== "seed") {
      return;
    }

    assert(
      !this.#variableSeeds.has(operation.variable),
      `${site.path} seeds the same variable more than once`
    );
    this.#variableSeeds.set(operation.variable, site);
  }

  #recordProducer(output: ValueRef, site: RegionNodeSite): void {
    const slot = this.#slotOf(output);

    assert(slot?.source === "producer", `${site.path} producer output is not a producer value`);
    assert(!this.#producers.has(slot), "producer output has more than one producer");
    this.#producers.set(slot, site);
  }

  // Validation reads the resolutions the builder already made, so it never
  // resolves a value and cannot fail a scope check the builder passed.
  #recordOf(value: ValueRef): ValueRecord {
    return this.#values.recordOf(value);
  }

  #slotOf(value: ValueRef): ValueSlot | undefined {
    return this.#recordOf(value).bound?.slot;
  }

  #indexScopedInputs(nested: ControlRegion, site: RegionNodeSite): void {
    if (nested.scope.kind === "ordinary") {
      return;
    }

    for (const input of nested.scope.inputs) {
      const slot = this.#slotOf(input);

      assert(
        slot?.source === "loopInput",
        `${site.path}.${nested.role} scoped input is not a loopInput value`
      );
      assert(
        !this.#loopInputs.has(slot),
        `${site.path} reuses loop input across carried values or loops`
      );
      this.#loopInputs.set(slot, nested.body);
    }
  }

  #assertEveryProducerOutputHasProducer(): void {
    for (const slot of this.#values.declaredSlots()) {
      if (slot.source === "producer") {
        assert(this.#producers.has(slot), "producer output has no producer");
      }
    }
  }

  // A body carries a result exactly when its ordinary owner declares an
  // output. `enclosingLoop` is the innermost loop whose back edge a continue
  // in this body would take.
  #validateRegion(body: Region, context: RegionValidationContext): void {
    const last = body.nodes[body.nodes.length - 1];

    // A wrong recorded bit is a wrong seal byte; check it against the children's.
    assert(
      body.completes === (last?.category === "control" && controlCompletes(last)),
      `${context.path} records the wrong completion`
    );
    this.#validateRegionResult(body, context);

    for (const [nodeIndex, node] of body.nodes.entries()) {
      const site: RegionNodeSite = {
        body,
        nodeIndex,
        path: `${context.path}.${node.kind}[${nodeIndex}]`
      };

      this.#validateNode(node, site, context);

      if (node.category === "control" && controlCompletes(node)) {
        assert(
          nodeIndex === body.nodes.length - 1,
          `${context.path} has nodes after its terminal ${node.kind} control`
        );
      }

      this.#validateNestedBodies(node, site, context);
    }

    if (body.result !== undefined) {
      this.#validateValueUse(
        body.result,
        {
          body,
          nodeIndex: body.nodes.length,
          path: `${context.path} fallthrough`
        },
        `${context.path} result`
      );
    }
  }

  #validateRegionResult(body: Region, context: RegionValidationContext): void {
    if (body.result !== undefined) {
      assert(
        context.ownerOutput !== undefined,
        `${context.path} carries a result without an owner output`
      );
      assert(!body.completes, `${context.path} carries a result but completes`);

      const resultType = valueTypeOf(body.result);
      const outputType = valueTypeOf(context.ownerOutput);

      assert(
        sameValueType(resultType, outputType),
        `${context.path} result type does not match its owner output: ${typeName(resultType)} for ${typeName(outputType)}`
      );
      return;
    }

    assert(context.ownerOutput === undefined, `${context.path} must carry a result`);
  }

  #validateNode(node: RegionNode, site: RegionNodeSite, context: RegionValidationContext): void {
    if (node.category === "operation") {
      this.#validateOperationInputs(node, site);
      this.#validateVariableAccess(node, site);
      return;
    }

    for (const operand of controlOperands(node)) {
      this.#validateValueUse(operand, site, `${site.path} operand ${operand}`);
    }

    switch (node.kind) {
      case "if":
      case "switch":
      case "loop":
        return;
      case "loopContinue":
        this.#validateLoopContinue(node.updates, site, context);
        return;
      case "return":
        this.#validateReturn(node, site.path);
        return;
    }
  }

  #validateOperationInputs(operation: Operation, site: RegionNodeSite): void {
    for (const input of operationOperands(operation)) {
      this.#validateValueUse(input, site, `${site.path} operand ${input}`);
    }
  }

  #validateVariableAccess(operation: Operation, site: RegionNodeSite): void {
    if (operation.kind !== "variable.read" && operation.kind !== "variable.write") {
      return;
    }

    const seed = this.#variableSeeds.get(operation.variable);

    assert(seed !== undefined, `${site.path} uses a variable with no seed in this root`);
    if (operation.kind === "variable.write" && operation.initialization === "seed") {
      return;
    }
    this.#assertVariableSeedDominates(seed, site);
  }

  #assertVariableSeedDominates(seed: RegionNodeSite, use: RegionNodeSite): void {
    if (seed.body === use.body) {
      assert(
        seed.nodeIndex < use.nodeIndex,
        `${use.path} reads or writes a variable before its seed`
      );
      return;
    }

    for (let body = use.body; body !== seed.body;) {
      const owner = this.#regionOwners.get(body);

      assert(
        owner !== undefined && owner !== null,
        `${use.path} uses a variable outside its declaring body or descendants`
      );
      if (owner.body === seed.body) {
        assert(
          seed.nodeIndex < owner.nodeIndex,
          `${use.path} reads or writes a variable before its seed`
        );
        return;
      }
      body = owner.body;
    }
  }

  #validateLoopContinue(
    updates: readonly ValueRef[],
    site: RegionNodeSite,
    context: RegionValidationContext
  ): void {
    const loop = context.enclosingLoop;

    assert(loop !== undefined, `${site.path} has a loopContinue outside any loop body`);
    assert(
      updates.length === loop.inputs.length,
      `${site.path} loopContinue updates do not align with the enclosing loop's carried values`
    );
    for (const [index, update] of updates.entries()) {
      const input = loop.inputs[index];

      assert(input !== undefined, `${site.path} enclosing loop has no input ${index}`);

      const updateType = valueTypeOf(update);
      const inputType = valueTypeOf(input);

      assert(
        sameValueType(updateType, inputType),
        `${site.path} update ${index} types do not match: ${typeName(updateType)} for ${typeName(inputType)}`
      );
    }
  }

  #validateNestedBodies(
    node: RegionNode,
    site: RegionNodeSite,
    context: RegionValidationContext
  ): void {
    if (node.category === "operation") {
      return;
    }
    const ownerOutput = controlOutput(node);

    for (const nested of controlRegions(node)) {
      if (nested.scope.kind === "loop") {
        this.#validateRegion(nested.body, {
          path: `${site.path}.${nested.role}`,
          ownerOutput: undefined,
          enclosingLoop: nested.scope
        });
      } else {
        this.#validateRegion(nested.body, {
          path: `${site.path}.${nested.role}`,
          ownerOutput,
          enclosingLoop: context.enclosingLoop
        });
      }
    }
  }

  #validateValueUse(value: ValueRef, site: RegionNodeSite, path: string): void {
    const visited = new Set<ValueRecord>();

    const visit = (used: ValueRef): void => {
      const record = this.#recordOf(used);

      if (visited.has(record)) {
        return;
      }
      visited.add(record);

      const slot = record.bound?.slot;

      if (slot === undefined) {
        for (const operand of [record.a, record.b, record.c]) {
          if (operand !== undefined) {
            visit(operand);
          }
        }
        return;
      }
      switch (slot.source) {
        case "parameter":
          assert(
            this.#parameterSlots.has(slot),
            `a function parameter is used outside its defining function at ${path}`
          );
          return;
        case "producer": {
          const producer = this.#producers.get(slot);

          assert(producer !== undefined, `a producer output used at ${path} has no producer`);
          this.#assertProducerDominatesUse(producer, site, path);
          return;
        }
        case "loopInput": {
          const definition = this.#loopInputs.get(slot);

          assert(definition !== undefined, `a loop input used at ${path} has no owning loop`);
          assert(
            this.#bodyIsWithin(site.body, definition),
            `a loop input is used outside its owning loop body at ${path}`
          );
          return;
        }
      }
    };

    visit(value);
  }

  #assertProducerDominatesUse(producer: RegionNodeSite, use: RegionNodeSite, path: string): void {
    if (producer.body === use.body) {
      assert(
        producer.nodeIndex < use.nodeIndex,
        `a producer output produced at ${producer.path} does not dominate ${path}`
      );
      return;
    }

    for (let body = use.body; body !== producer.body;) {
      const owner = this.#regionOwners.get(body);

      assert(
        owner !== undefined && owner !== null,
        `a producer output produced at ${producer.path} does not dominate ${path}`
      );

      if (owner.body === producer.body) {
        assert(
          producer.nodeIndex < owner.nodeIndex,
          `a producer output produced at ${producer.path} does not dominate ${path}`
        );
        return;
      }

      body = owner.body;
    }
  }

  #bodyIsWithin(body: Region, scope: Region): boolean {
    for (let current = body; ;) {
      if (current === scope) {
        return true;
      }

      const owner = this.#regionOwners.get(current);

      if (owner === undefined || owner === null) {
        return false;
      }
      current = owner.body;
    }
  }

  #validateParameters(): void {
    const fn = this.#function;

    assert(
      fn.parameters.length === fn.type.parameters.length,
      `function declares ${fn.parameters.length} parameters for ${fn.type.parameters.length} types`
    );
    for (const [index, parameter] of fn.parameters.entries()) {
      const slot = this.#slotOf(parameter);
      const expectedType = fn.type.parameters[index];

      assert(slot?.source === "parameter", "a function parameter is not a parameter value");
      assert(expectedType !== undefined, `function has no parameter ${index}`);
      assert(slot.index === index, `function parameter has index ${slot.index}, expected ${index}`);
      this.#validateFunctionValue(parameter, expectedType, `function parameter ${index}`);
      this.#parameterSlots.add(slot);
    }

    for (const slot of this.#values.declaredSlots()) {
      if (slot.source === "parameter") {
        assert(this.#parameterSlots.has(slot), "undeclared function parameter value");
      }
    }
  }

  #validateReturn(control: Extract<Control, { kind: "return" }>, path: string): void {
    const fn = this.#function;

    const source = control.source;

    if (source.kind === "invocation") {
      const invocation = source.invocation;
      const targetResults = invocation.target.type.results;

      assert(
        targetResults.length === fn.type.results.length &&
          targetResults.every((type, index) => {
            const expected = fn.type.results[index];

            return expected !== undefined && sameValueType(type, expected);
          }),
        `${path} invocation results do not match the enclosing function`
      );
      this.#validateInvocation(invocation, path);
      return;
    }

    const results = source.values;

    assert(
      results.length === fn.type.results.length,
      `${path} returns ${results.length} values, expected ${fn.type.results.length}`
    );
    for (const [index, value] of results.entries()) {
      const expectedType = fn.type.results[index];

      assert(expectedType !== undefined, `${path} has no declared result ${index}`);
      this.#validateFunctionValue(value, expectedType, `${path} result ${index}`);
    }
  }

  #validateInvocation(invocation: Invocation, path: string): void {
    const parameters = invocation.target.type.parameters;

    assert(
      invocation.arguments.length === parameters.length,
      `${path} invocation has ${invocation.arguments.length} arguments, expected ${parameters.length}`
    );
    for (const [index, input] of invocation.arguments.entries()) {
      const expectedType = parameters[index];

      assert(expectedType !== undefined, `${path} invocation target has no parameter ${index}`);
      this.#validateFunctionValue(input, expectedType, `${path} argument ${index}`);
    }
  }

  #validateFunctionValue(value: ValueRef, type: ValueType, path: string): void {
    const actual = valueTypeOf(value);

    assert(
      sameValueType(actual, type),
      `${path} has the wrong value type: ${typeName(actual)}, expected ${typeName(type)}`
    );
  }
}

function typeName(type: ValueType): string {
  return `${type.kind}[${type.width}]`;
}
