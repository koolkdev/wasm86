import { assert } from "#common/assert.js";
import {
  controlCompletes,
  type Control
} from "#compiler/ir/controls/index.js";
import { invocationInputs } from "#compiler/ir/invocation.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import {
  describeOperation,
  type Operation
} from "#compiler/ir/operations/index.js";
import { valueId } from "#compiler/ir/values/id.js";
import { unboundedWidthBounds } from "#compiler/ir/values/width-bounds.js";
import type {
  ValueId,
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
import {
  describeNode,
  type NestedRegion
} from "./node.js";
import {
  validateResourceOperation,
  validateStorageEffectRanges
} from "./validate/resource.js";

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
    validateStorageEffectRanges(describeNode(node).effects, site.path);

    if (node.category === "operation") {
      this.#validateOperationDeclaration(node, site.path);
      this.#indexOperationOutputs(node, site);
      this.#indexVariableDefinition(node, site);
      return;
    }

    this.#validateControlSemantics(node, site.path);
    this.#indexControlOutputs(node, site);

    for (const nested of describeNode(node).nestedBodies) {
      this.#indexScopedInputs(nested, site);
      this.#indexNestedBody(nested.body, site, `${site.path}.${nested.role}`);
    }
  }

  #validateOperationDeclaration(operation: Operation, path: string): void {
    for (const { output, result } of describeOperation(operation).productions) {
      assert(
        this.#block.values.valueType(output) === result.type,
        `${path} output ${output} must be ${result.type}`
      );
      assertOutputBounds(this.#block, operation.kind, output, result);
    }

    switch (operation.kind) {
      case "call":
      case "variable.read":
      case "variable.write":
        return;
      case "resource.read":
      case "resource.write":
        validateResourceOperation(operation, path);
        return;
    }
  }

  #validateControlSemantics(control: Control, path: string): void {
    if (control.kind !== "loop") {
      return;
    }

    for (const [index, carried] of control.carried.entries()) {
      assert(
        this.#block.values.valueType(carried.seed) ===
          this.#block.values.valueType(carried.loopInput),
        `${path} carried value ${index} seed and input types do not match`
      );
    }
  }

  #indexOperationOutputs(
    operation: Operation,
    site: RegionNodeSite
  ): void {
    const { outputs } = describeNode(operation);

    for (const output of outputs) {
      this.#recordProducer(output, site);
    }
  }

  #indexControlOutputs(control: Control, site: RegionNodeSite): void {
    const { outputs } = describeNode(control);

    for (const output of outputs) {
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

      if (
        node.category === "control" &&
        controlCompletes(node, { regionCompletes })
      ) {
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

    for (const operand of describeNode(node).operands) {
      this.#validateValueUse(operand, site, `${site.path} operand ${operand}`);
    }

    switch (node.kind) {
      case "if":
        assertValueType(this.#block, node.condition, "i32", `${site.path} condition`);
        return;
      case "switch":
        assertValueType(this.#block, node.selector, "i32", `${site.path} selector`);
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
    for (const input of describeNode(operation).inputs) {
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
    const { nestedBodies, outputs } = describeNode(node);
    const ownerOutput = outputs[0];

    for (const nested of nestedBodies) {
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
      for (const [index, input] of invocationInputs(invocation).entries()) {
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

function boundsEqual(a: WidthBounds, b: WidthBounds): boolean {
  return a.unsignedBits === b.unsignedBits && a.signedBits === b.signedBits;
}

function formatBounds(bounds: WidthBounds): string {
  return `{ unsignedBits: ${bounds.unsignedBits}, signedBits: ${bounds.signedBits} }`;
}
