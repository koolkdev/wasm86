import { assert } from "#common/assert.js";
import type {
  StorageAccess,
  StorageEffects
} from "#compiler/ir/effects.js";
import {
  maxSwitchMatch,
  type Control,
  type IfControl,
  type SwitchControl
} from "#compiler/ir/controls/index.js";
import type { Invocation } from "#compiler/ir/invocation.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import type {
  CallOperation,
  VariableReadOperation,
  VariableWriteOperation,
  Operation
} from "#compiler/ir/operations/index.js";
import { valueId } from "#compiler/ir/values/id.js";
import { unboundedWidthBounds } from "#compiler/ir/values/width-bounds.js";
import type {
  ValueId,
  ValueInput,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { VariableRef } from "#compiler/ir/variable.js";
import {
  regionCompletes,
  type Region,
  type RegionNode
} from "./region.js";
import type { FunctionGraph, IrFunction } from "./function.js";
import type { NestedRegion } from "./node.js";
import { validateDeclaredStorageEffects } from "./validate/effects.js";
import { validateResourceOperation } from "./validate/resource.js";

type RegionNodeSite = Readonly<{
  body: Region;
  nodeIndex: number;
  path: string;
}>;

type RegionOwner = Readonly<{
  body: Region;
  nodeIndex: number;
}>;

type LoopScope = Extract<
  NestedRegion["scope"],
  { kind: "loop" }
>;

type RegionValidationContext = Readonly<{
  path: string;
  ownerOutput: ValueId | undefined;
  enclosingLoop: LoopScope | undefined;
}>;

type FunctionValidation = Readonly<{
  parameters: readonly ValueId[];
  parameterTypes: readonly ValueType[];
  results: readonly ValueType[];
}>;

export function validateIrFunction(fn: IrFunction): void {
  new IrValidator(fn, {
    parameters: fn.parameters,
    parameterTypes: fn.type.parameters,
    results: fn.type.results
  }).validate();
}

// Validation has two phases. Indexing establishes the unique body tree and all
// scoped definitions; the semantic walk can then reject forward and escaping
// uses without depending on traversal order.
class IrValidator {
  readonly #block: FunctionGraph;
  readonly #regionOwners = new Map<Region, RegionOwner | null>();
  readonly #producers = new Map<ValueId, RegionNodeSite>();
  readonly #loopInputs = new Map<ValueId, Region>();
  readonly #variableSeeds = new Map<VariableRef, RegionNodeSite>();
  readonly #function: FunctionValidation;
  readonly #parameterValues = new Set<ValueId>();

  constructor(block: FunctionGraph, fn: FunctionValidation) {
    this.#block = block;
    this.#function = fn;
    this.#regionOwners.set(block.body, null);
  }

  validate(): void {
    this.#validateParameters();
    this.#indexBody(this.#block.body, "body");
    this.#assertEveryNodeOutputHasProducer();
    this.#validateRegion(this.#block.body, {
      path: "body",
      ownerOutput: undefined,
      enclosingLoop: undefined
    });
    assert(regionCompletes(this.#block.body), "root body does not complete");
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
      this.#validateOperationDeclaration(node, site.path);
      this.#indexOperationOutputs(node, site);
      this.#indexVariableDefinition(node, site);
      return;
    }

    this.#validateControlDeclaration(node, site.path);
    this.#indexControlOutputs(node, site);

    for (const nested of node.nestedBodies) {
      this.#indexScopedInputs(nested, site);
      this.#indexNestedBody(nested.body, site, `${site.path}.${nested.role}`);
    }
  }

  #validateOperationDeclaration(operation: Operation, path: string): void {
    assert(Array.isArray(operation.inputs), `${path} inputs must be an array`);
    assert(Array.isArray(operation.results), `${path} results must be an array`);

    const operands = operation.operands;
    const outputs = operation.outputs;

    assert(Array.isArray(operands), `${path} operands must be an array`);
    assert(Array.isArray(outputs), `${path} outputs must be an array`);
    assert(
      Array.isArray(operation.referencedResources),
      `${path} referenced resources must be an array`
    );
    assert(
      Array.isArray(operation.nestedBodies) && operation.nestedBodies.length === 0,
      `${path} operation must not have nested bodies`
    );
    assert(
      operands.length === operation.inputs.length,
      `${path} declares ${operands.length} operands for ${operation.inputs.length} inputs`
    );
    for (const [index, input] of operation.inputs.entries()) {
      assert(
        operands[index] === input.value,
        `${path} operand ${index} does not match its declared input`
      );
    }
    assert(
      outputs.length === operation.results.length,
      `${path} declares ${outputs.length} outputs for ${operation.results.length} results`
    );
    validateDeclaredStorageEffects(operation.directEffects, path);

    for (const [index, result] of operation.results.entries()) {
      const output = outputs[index];

      assert(output !== undefined, `${path} has no output ${index}`);
      validateOperationResult(result, `${path} result ${index}`);
      assert(
        this.#block.values.valueType(output) === result.type,
        `${path} output ${index} must be ${result.type}`
      );
      assertOutputBounds(this.#block, operation.kind, output, result);
    }

    switch (operation.kind) {
      case "call":
        this.#validateCallDeclaration(operation, path);
        return;
      case "variable.read":
      case "variable.write":
        validateVariableOperation(operation, path);
        return;
      case "resource.read":
      case "resource.write":
        validateResourceOperation(operation, path);
        return;
    }

    operation satisfies never;
  }

  #validateCallDeclaration(call: CallOperation, path: string): void {
    const invocation = call.invocation;
    const resultTypes = invocation.target.type.results;

    validateInvocation(invocation, `${path} invocation`);

    assert(
      resultTypes.length <= 1,
      `${path} target has ${resultTypes.length} results; multiple call results are not supported yet`
    );

    assertSameInputs(
      call.inputs,
      invocation.inputs,
      `${path} inputs do not match its invocation`
    );
    assert(
      call.results.length === resultTypes.length,
      `${path} declares ${call.results.length} results for ${resultTypes.length} target results`
    );
    for (const [index, result] of call.results.entries()) {
      const expected = resultTypes[index];

      assert(expected !== undefined, `${path} target has no result ${index}`);
      assert(
        result.type === expected,
        `${path} result ${index} declares ${result.type}, expected ${expected}`
      );
      if (result.type === "i32") {
        assert(
          result.bounds === undefined,
          `${path} call result ${index} must not invent width bounds`
        );
      }
    }
    assert(
      call.directEffects === invocation.target.effects,
      `${path} effects do not match its invocation`
    );
    assert(
      call.referencedResources.length === 0,
      `${path} call must not require caller resource bindings`
    );
  }

  #validateControlDeclaration(control: Control, path: string): void {
    const operands = control.operands;
    const outputs = control.outputs;
    const nestedBodies = control.nestedBodies;
    const directEffects = control.directEffects;

    assert(Array.isArray(operands), `${path} operands must be an array`);
    assert(Array.isArray(outputs), `${path} outputs must be an array`);
    assert(Array.isArray(nestedBodies), `${path} nested bodies must be an array`);
    assert(outputs.length <= 1, `${path} control has multiple join outputs`);
    validateDeclaredStorageEffects(directEffects, path);

    switch (control.kind) {
      case "if":
        validateIfControlShape(
          control,
          operands,
          outputs,
          nestedBodies,
          directEffects,
          path
        );
        return;
      case "switch":
        validateSwitchControlShape(
          control,
          operands,
          outputs,
          nestedBodies,
          directEffects,
          path
        );
        return;
      case "loop":
        validateLoopControlShape(
          control,
          operands,
          outputs,
          nestedBodies,
          directEffects,
          this.#block,
          path
        );
        return;
      case "loopContinue":
        assertNoControlResults(outputs, nestedBodies, path);
        assertSameValues(
          operands,
          control.updates,
          `${path} operands do not match its updates`
        );
        assertNoDirectEffects(directEffects, path);
        return;
      case "return":
        validateReturnControlShape(
          control,
          operands,
          outputs,
          nestedBodies,
          directEffects,
          path
        );
        return;
    }
  }

  #indexOperationOutputs(
    operation: Operation,
    site: RegionNodeSite
  ): void {
    const outputs = operation.outputs;

    for (const output of outputs) {
      for (const input of operation.inputs) {
        assert(
          input.value < output,
          `producer operand ${input.value} created after its output ${output}`
        );
      }
      this.#recordProducer(output, site);
    }
  }

  #indexControlOutputs(control: Control, site: RegionNodeSite): void {
    const outputs = control.outputs;
    const operands = control.operands;
    const nestedBodies = control.nestedBodies;

    for (const output of outputs) {
      for (const operand of operands) {
        assert(
          operand < output,
          `${control.kind} operand ${operand} created after its output ${output}`
        );
      }
      for (const nested of nestedBodies) {
        if (nested.scope.kind === "ordinary" && nested.body.result !== undefined) {
          assert(
            nested.body.result < output,
            `${control.kind} result ${nested.body.result} created after its output ${output}`
          );
        }
      }
      this.#recordProducer(output, site);
    }
  }

  #indexNestedBody(
    body: Region,
    owner: RegionNodeSite,
    path: string
  ): void {
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
    if (
      operation.kind !== "variable.write" ||
      operation.initialization !== "seed"
    ) {
      return;
    }

    assert(
      !this.#variableSeeds.has(operation.variable),
      `${site.path} seeds the same variable more than once`
    );
    this.#variableSeeds.set(operation.variable, site);
  }

  #recordProducer(output: ValueId, site: RegionNodeSite): void {
    assert(
      this.#block.values.node(output).kind === "nodeOutput",
      `${site.path} producer output ${output} is not a nodeOutput value`
    );
    assert(
      !this.#producers.has(output),
      `node output ${output} has more than one producer`
    );
    this.#producers.set(output, site);
  }

  #indexScopedInputs(
    nested: NestedRegion,
    site: RegionNodeSite
  ): void {
    if (nested.scope.kind === "ordinary") {
      return;
    }

    for (const input of nested.scope.inputs) {
      assert(
        this.#block.values.node(input).kind === "loopInput",
        `${site.path}.${nested.role} scoped input ${input} is not a loopInput value`
      );
      assert(
        !this.#loopInputs.has(input),
        `${site.path} reuses loop input ${input} across carried values or loops`
      );
      this.#loopInputs.set(input, nested.body);
    }
  }

  #assertEveryNodeOutputHasProducer(): void {
    for (let rawId = 0; rawId < this.#block.values.size(); rawId += 1) {
      const id = valueId(rawId);

      if (this.#block.values.node(id).kind === "nodeOutput") {
        assert(this.#producers.has(id), `node output ${id} has no producer`);
      }
    }
  }

  // A body carries a result exactly when its ordinary owner declares an
  // output. `enclosingLoop` is the innermost loop whose back edge a continue
  // in this body would take.
  #validateRegion(body: Region, context: RegionValidationContext): void {
    this.#validateRegionResult(body, context);

    for (const [nodeIndex, node] of body.nodes.entries()) {
      const site: RegionNodeSite = {
        body,
        nodeIndex,
        path: `${context.path}.${node.kind}[${nodeIndex}]`
      };

      this.#validateNode(node, site, context);

      if (node.completes({ regionCompletes })) {
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
      assert(!regionCompletes(body), `${context.path} carries a result but completes`);
      assert(
        this.#block.values.valueType(body.result) ===
          this.#block.values.valueType(context.ownerOutput),
        `${context.path} result type does not match its owner output`
      );
      if (!this.#block.values.isUnreachable(body.result)) {
        const resultBounds = this.#block.values.widthBounds(body.result);
        const outputBounds = this.#block.values.widthBounds(context.ownerOutput);

        assert(
          outputBounds.unsignedBits >= resultBounds.unsignedBits &&
            outputBounds.signedBits >= resultBounds.signedBits,
          `${context.path} result bounds exceed its owner output bounds`
        );
      }
      return;
    }

    assert(context.ownerOutput === undefined, `${context.path} must carry a result`);
  }

  #validateNode(
    node: RegionNode,
    site: RegionNodeSite,
    context: RegionValidationContext
  ): void {
    if (node.category === "operation") {
      this.#validateOperationInputs(node, site);
      this.#validateVariableAccess(node, site);
      return;
    }

    for (const operand of node.operands) {
      this.#validateValueUse(operand, site, `${site.path} operand ${operand}`);
    }

    switch (node.kind) {
      case "if":
        assertValueType(this.#block, node.condition, "i32", `${site.path} condition`);
        return;
      case "switch":
        assertValueType(this.#block, node.selector, "i32", `${site.path} selector`);
        validateSwitchCases(node, site.path);
        return;
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

  #validateOperationInputs(
    operation: Operation,
    site: RegionNodeSite
  ): void {
    for (const input of operation.inputs) {
      const actualType = this.#block.values.valueType(input.value);

      assert(
        actualType === input.type,
        `${site.path} operand ${input.value} must be ${input.type}, got ${actualType}`
      );
      this.#validateValueUse(
        input.value,
        site,
        `${site.path} operand ${input.value}`
      );
    }
  }

  #validateVariableAccess(operation: Operation, site: RegionNodeSite): void {
    if (
      operation.kind !== "variable.read" &&
      operation.kind !== "variable.write"
    ) {
      return;
    }

    const seed = this.#variableSeeds.get(operation.variable);

    assert(
      seed !== undefined,
      `${site.path} uses a variable with no seed in this root`
    );
    if (
      operation.kind === "variable.write" &&
      operation.initialization === "seed"
    ) {
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

    for (let body = use.body; body !== seed.body; ) {
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
    updates: readonly ValueId[],
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
      assert(
        this.#block.values.valueType(update) === this.#block.values.valueType(input),
        `${site.path} update ${index} does not match its loop input type`
      );
    }
  }

  #validateNestedBodies(
    node: RegionNode,
    site: RegionNodeSite,
    context: RegionValidationContext
  ): void {
    const outputs = node.outputs;

    assert(outputs.length <= 1, `${site.path} has multiple nested-body outputs`);
    const ownerOutput = outputs[0];

    for (const nested of node.nestedBodies) {
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

  #validateValueUse(
    value: ValueId,
    site: RegionNodeSite,
    path: string
  ): void {
    const visited = new Set<ValueId>();

    const visit = (id: ValueId): void => {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);

      const valueNode = this.#block.values.node(id);

      switch (valueNode.kind) {
        case "parameter":
          assert(
            this.#parameterValues.has(id),
            `function parameter ${id} is used outside its defining function at ${path}`
          );
          return;
        case "nodeOutput": {
          const producer = this.#producers.get(id);

          assert(producer !== undefined, `node output ${id} used at ${path} has no producer`);
          this.#assertProducerDominatesUse(id, producer, site, path);
          return;
        }
        case "loopInput": {
          const definition = this.#loopInputs.get(id);

          assert(definition !== undefined, `loop input ${id} used at ${path} has no owning loop`);
          assert(
            this.#bodyIsWithin(site.body, definition),
            `loop input ${id} is used outside its owning loop body at ${path}`
          );
          return;
        }
        default:
          for (const child of this.#block.values.children(id)) {
            visit(child);
          }
      }
    };

    visit(value);
  }

  #assertProducerDominatesUse(
    output: ValueId,
    producer: RegionNodeSite,
    use: RegionNodeSite,
    path: string
  ): void {
    if (producer.body === use.body) {
      assert(
        producer.nodeIndex < use.nodeIndex,
        `node output ${output} produced at ${producer.path} does not dominate ${path}`
      );
      return;
    }

    for (let body = use.body; body !== producer.body; ) {
      const owner = this.#regionOwners.get(body);

      assert(
        owner !== undefined && owner !== null,
        `node output ${output} produced at ${producer.path} does not dominate ${path}`
      );

      if (owner.body === producer.body) {
        assert(
          producer.nodeIndex < owner.nodeIndex,
          `node output ${output} produced at ${producer.path} does not dominate ${path}`
        );
        return;
      }

      body = owner.body;
    }
  }

  #bodyIsWithin(body: Region, scope: Region): boolean {
    for (let current = body; ; ) {
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
      fn.parameters.length === fn.parameterTypes.length,
      `function declares ${fn.parameters.length} parameters for ${fn.parameterTypes.length} types`
    );
    for (const [index, parameter] of fn.parameters.entries()) {
      const node = this.#block.values.node(parameter);
      const expectedType = fn.parameterTypes[index];

      assert(node.kind === "parameter", `function parameter ${parameter} is not a parameter value`);
      assert(expectedType !== undefined, `function has no parameter type ${index}`);
      assert(
        node.index === index,
        `function parameter ${parameter} has index ${node.index}, expected ${index}`
      );
      assert(
        this.#block.values.valueType(parameter) === expectedType,
        `function parameter ${parameter} must be ${expectedType}`
      );
      this.#parameterValues.add(parameter);
    }

    for (let raw = 0; raw < this.#block.values.size(); raw += 1) {
      const id = valueId(raw);

      if (this.#block.values.node(id).kind === "parameter") {
        assert(this.#parameterValues.has(id), `undeclared function parameter value ${id}`);
      }
    }
  }

  #validateReturn(
    control: Extract<Control, { kind: "return" }>,
    path: string
  ): void {
    const fn = this.#function;

    const source = control.source;

    if (source.kind === "invocation") {
      const invocation = source.invocation;
      const targetResults = invocation.target.type.results;

      assert(
        targetResults.length === fn.results.length &&
          targetResults.every((type, index) => type === fn.results[index]),
        `${path} invocation results do not match the enclosing function`
      );
      for (const [index, input] of invocation.inputs.entries()) {
        const actual = this.#block.values.valueType(input.value);

        assert(
          actual === input.type,
          `${path} invocation input ${index} must be ${input.type}, got ${actual}`
        );
      }
      return;
    }

    const results = source.values;

    assert(
      results.length === fn.results.length,
      `${path} returns ${results.length} values, expected ${fn.results.length}`
    );
    for (const [index, value] of results.entries()) {
      const expected = fn.results[index];

      assert(expected !== undefined, `${path} has no declared result ${index}`);
      const actual = this.#block.values.valueType(value);

      assert(actual === expected, `${path} result ${index} must be ${expected}, got ${actual}`);
    }
  }

}

function validateOperationResult(result: OperationResult, path: string): void {
  assert(result !== null && typeof result === "object", `${path} must be an object`);

  switch (result.type) {
    case "i32":
      if (result.bounds !== undefined) {
        validateWidthBounds(result.bounds, path);
      }
      return;
    case "i64":
      assert(!Object.hasOwn(result, "bounds"), `${path} i64 result must not declare width bounds`);
      return;
  }
}

function validateVariableOperation(
  operation: VariableReadOperation | VariableWriteOperation,
  path: string
): void {
  assert(
    operation.referencedResources.length === 0,
    `${path} variable operation must not require resource bindings`
  );

  switch (operation.kind) {
    case "variable.read": {
      const result = operation.results[0];

      assert(operation.inputs.length === 0, `${path} must not have inputs`);
      assert(
        operation.results.length === 1 && result !== undefined,
        `${path} must have exactly one result`
      );
      assert(
        result.type === operation.variable.type,
        `${path} result type must match its variable`
      );
      assert(
        result.type !== "i32" || result.bounds === undefined,
        `${path} result must not refine its variable value bounds`
      );
      assert(
        operation.directEffects.reads.length === 1 &&
          isVariableAccess(
            operation.directEffects.reads[0],
            operation.variable
          ) &&
          operation.directEffects.writes.length === 0,
        `${path} effects must read its exact variable and write nothing`
      );
      return;
    }
    case "variable.write": {
      const input = operation.inputs[0];

      assert(
        operation.initialization === "seed" ||
          operation.initialization === "update",
        `${path} has an invalid variable-write initialization`
      );
      assert(
        operation.inputs.length === 1 &&
          input !== undefined &&
          input.value === operation.value &&
          input.type === operation.variable.type,
        `${path} must have exactly its variable-typed value input`
      );
      assert(operation.results.length === 0, `${path} must not have results`);
      assert(
        operation.directEffects.reads.length === 0 &&
          operation.directEffects.writes.length === 1 &&
          isVariableAccess(
            operation.directEffects.writes[0],
            operation.variable
          ),
        `${path} effects must write its exact variable and read nothing`
      );
      return;
    }
  }
}

function isVariableAccess(
  access: StorageAccess | undefined,
  variable: VariableRef
): boolean {
  return access?.space === "variable" && access.variable === variable;
}

function validateIfControlShape(
  control: IfControl,
  operands: readonly ValueId[],
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedRegion[],
  directEffects: StorageEffects,
  path: string
): void {
  assertSameValues(
    operands,
    [control.condition],
    `${path} operands do not match its condition`
  );
  const expectedOutputs = control.output === undefined ? [] : [control.output];

  assertSameValues(outputs, expectedOutputs, `${path} outputs do not match its output field`);
  assert(
    control.output === undefined || control.elseBody !== undefined,
    `${path} value-producing if is missing its else body`
  );
  assert(
    nestedBodies.length === (control.elseBody === undefined ? 1 : 2),
    `${path} nested bodies do not match its branches`
  );
  assertOrdinaryBody(
    nestedBodies[0],
    control.thenBody,
    "thenBody",
    `${path}.thenBody`
  );
  if (control.elseBody !== undefined) {
    assertOrdinaryBody(
      nestedBodies[1],
      control.elseBody,
      "elseBody",
      `${path}.elseBody`
    );
  }
  assertNoDirectEffects(directEffects, path);
}

function validateSwitchControlShape(
  control: SwitchControl,
  operands: readonly ValueId[],
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedRegion[],
  directEffects: StorageEffects,
  path: string
): void {
  assertSameValues(
    operands,
    [control.selector],
    `${path} operands do not match its selector`
  );
  const expectedOutputs = control.output === undefined ? [] : [control.output];

  assertSameValues(outputs, expectedOutputs, `${path} outputs do not match its output field`);
  assert(
    nestedBodies.length === control.cases.length + 1,
    `${path} nested bodies do not match its cases and default`
  );
  for (const [index, entry] of control.cases.entries()) {
    assertOrdinaryBody(
      nestedBodies[index],
      entry.body,
      `case[${index}]`,
      `${path}.case[${index}]`
    );
  }
  assertOrdinaryBody(
    nestedBodies[control.cases.length],
    control.defaultBody,
    "default",
    `${path}.default`
  );
  assertNoDirectEffects(directEffects, path);
}

function validateLoopControlShape(
  control: Extract<Control, { kind: "loop" }>,
  operands: readonly ValueId[],
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedRegion[],
  directEffects: StorageEffects,
  block: FunctionGraph,
  path: string
): void {
  assertNoOutputs(outputs, path);
  assertSameValues(
    operands,
    control.carried.map((entry) => entry.seed),
    `${path} operands do not match its carried seeds`
  );
  assert(nestedBodies.length === 1, `${path} must have exactly one loop body`);
  const nested = nestedBodies[0];

  assert(nested !== undefined && nested.body === control.body, `${path} has the wrong loop body`);
  assert(nested.role === "body", `${path} loop body has the wrong role`);
  assert(nested.scope.kind === "loop", `${path} body must establish a loop scope`);
  assertSameValues(
    nested.scope.inputs,
    control.carried.map((entry) => entry.loopInput),
    `${path} loop scope does not match its carried inputs`
  );
  for (const [index, carried] of control.carried.entries()) {
    assert(
      block.values.valueType(carried.seed) === block.values.valueType(carried.loopInput),
      `${path} carried value ${index} seed and input types do not match`
    );
  }
  assertNoDirectEffects(directEffects, path);
}

function validateReturnControlShape(
  control: Extract<Control, { kind: "return" }>,
  operands: readonly ValueId[],
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedRegion[],
  directEffects: StorageEffects,
  path: string
): void {
  assertNoControlResults(outputs, nestedBodies, path);
  const source = control.source;

  if (source.kind === "values") {
    assertSameValues(
      operands,
      source.values,
      `${path} operands do not match its return values`
    );
    assertNoDirectEffects(directEffects, path);
  } else {
    validateInvocation(source.invocation, `${path} invocation`);
    assertSameValues(
      operands,
      source.invocation.inputs.map((input) => input.value),
      `${path} operands do not match its invocation inputs`
    );
    assert(
      directEffects === source.invocation.target.effects,
      `${path} effects do not match its invocation`
    );
  }
  assert(
    control.completes({ regionCompletes }),
    `${path} return must complete its body`
  );
}

function validateInvocation(invocation: Invocation, path: string): void {
  assert(invocation !== null && typeof invocation === "object", `${path} must be an object`);
  assert(Array.isArray(invocation.arguments), `${path} arguments must be an array`);
  assert(Array.isArray(invocation.inputs), `${path} inputs must be an array`);

  const target = invocation.target;

  assert(target !== null && typeof target === "object", `${path} target must be an object`);
  assert(
    target.kind === "direct" || target.kind === "indirect",
    `${path} target must be direct or indirect`
  );
  const type = target.type;
  const effects = target.effects;
  const targetInputs: readonly ValueInput[] = target.kind === "direct"
    ? []
    : [target.elementIndex];

  if (target.kind === "indirect") {
    assert(
      target.elementIndex.type === "i32",
      `${path} table element index must be i32`
    );
  }
  const expectedInputs: readonly ValueInput[] = [
    ...invocation.arguments,
    ...targetInputs
  ];

  assert(Array.isArray(type.parameters), `${path} parameters must be an array`);
  assert(Array.isArray(type.results), `${path} results must be an array`);
  validateDeclaredStorageEffects(effects, `${path} target`);
  assert(
    invocation.arguments.length === type.parameters.length,
    `${path} passes ${invocation.arguments.length} arguments to ${type.parameters.length} parameters`
  );
  for (const [index, input] of invocation.arguments.entries()) {
    const expected = type.parameters[index];

    assert(expected !== undefined, `${path} target has no parameter ${index}`);
    assert(
      input.type === expected,
      `${path} argument ${index} declares ${input.type}, expected ${expected}`
    );
  }
  assertSameInputs(
    invocation.inputs,
    expectedInputs,
    `${path} inputs do not match its target and arguments`
  );
}

function assertNoControlResults(
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedRegion[],
  path: string
): void {
  assertNoOutputs(outputs, path);
  assert(nestedBodies.length === 0, `${path} must not have nested bodies`);
}

function assertNoOutputs(outputs: readonly ValueId[], path: string): void {
  assert(outputs.length === 0, `${path} must not have outputs`);
}

function assertOrdinaryBody(
  nested: NestedRegion | undefined,
  body: Region,
  role: string,
  path: string
): void {
  assert(nested !== undefined && nested.body === body, `${path} has the wrong body`);
  assert(nested.role === role, `${path} has the wrong role`);
  assert(nested.scope.kind === "ordinary", `${path} must have ordinary scope`);
}

function assertNoDirectEffects(effects: StorageEffects, path: string): void {
  assert(
    effects.reads.length === 0 && effects.writes.length === 0,
    `${path} must not have direct effects`
  );
}

function assertSameValues(
  actual: readonly ValueId[],
  expected: readonly ValueId[],
  message: string
): void {
  assert(
    actual.length === expected.length &&
      actual.every((value, index) => value === expected[index]),
    message
  );
}

function assertSameInputs(
  actual: readonly ValueInput[],
  expected: readonly ValueInput[],
  message: string
): void {
  assert(
    actual.length === expected.length &&
      actual.every((input, index) => {
        const expectedInput = expected[index];

        return expectedInput !== undefined &&
          input.value === expectedInput.value &&
          input.type === expectedInput.type;
      }),
    message
  );
}

function validateSwitchCases(control: SwitchControl, path: string): void {
  const seen = new Set<number>();

  for (const entry of control.cases) {
    assert(entry.matches.length > 0, `${path} has a case with no matches`);

    for (const match of entry.matches) {
      assert(
        Number.isInteger(match) && match >= 0 && match <= maxSwitchMatch,
        `${path} case match ${match} is not an integer in [0, ${maxSwitchMatch}]`
      );
      assert(!seen.has(match), `${path} has a duplicate case match ${match}`);
      seen.add(match);
    }
  }
}

function assertValueType(
  block: FunctionGraph,
  value: ValueId,
  expected: ValueType,
  path: string
): void {
  const actual = block.values.valueType(value);

  assert(actual === expected, `${path} must be ${expected}, got ${actual}`);
}

function assertOutputBounds(
  block: FunctionGraph,
  operationKind: string,
  output: ValueId,
  expected: OperationResult
): void {
  if (expected.type === "i64") {
    return;
  }

  const actualBounds = block.values.widthBounds(output);
  const expectedBounds = expected.bounds ?? unboundedWidthBounds;

  assert(
    boundsEqual(actualBounds, expectedBounds),
    `${operationKind} operation output ${output} has the wrong bounds: expected ${formatBounds(expectedBounds)}, got ${formatBounds(actualBounds)}`
  );
}

function validateWidthBounds(bounds: WidthBounds, path: string): void {
  assert(
    Number.isInteger(bounds.unsignedBits) &&
      bounds.unsignedBits >= 0 &&
      bounds.unsignedBits <= 32 &&
      Number.isInteger(bounds.signedBits) &&
      bounds.signedBits >= 0 &&
      bounds.signedBits <= 32 &&
      bounds.signedBits <= bounds.unsignedBits + 1,
    `${path} bounds are malformed`
  );
}

function boundsEqual(a: WidthBounds, b: WidthBounds): boolean {
  return a.unsignedBits === b.unsignedBits && a.signedBits === b.signedBits;
}

function formatBounds(bounds: WidthBounds): string {
  return `{ unsignedBits: ${bounds.unsignedBits}, signedBits: ${bounds.signedBits} }`;
}
