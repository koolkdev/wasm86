import { assert } from "#common/assert.js";
import type {
  StorageAccess,
  StorageEffects
} from "#compiler/ir/effects.js";
import {
  maxSwitchMatch,
  type Control,
  type IfControl,
  type ReturnCallControl,
  type SwitchControl
} from "#compiler/ir/controls/index.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import type {
  CallOperation,
  CellReadOperation,
  CellWriteOperation,
  Operation
} from "#compiler/ir/operations/index.js";
import { valueId } from "#compiler/ir/values/id.js";
import { unboundedWidthBounds } from "#compiler/ir/values/width-bounds.js";
import type {
  ValueId,
  ValueType,
  WidthBounds
} from "#compiler/ir/values/types.js";
import type { CellRef } from "#compiler/refs/cell.js";
import {
  bodyCompletes,
  type Body,
  type BodyNode,
  type IrBlock
} from "./block.js";
import type { IrFunction } from "./function.js";
import type { NestedBody } from "./node.js";
import { validateDeclaredStorageEffects } from "./validate/effects.js";
import { validateResourceOperation } from "./validate/resource.js";

export type ValidateIrBlockOptions = Readonly<{
  allowImplicitEntryFallthrough?: boolean;
  // Values the embedder consumes at the root body's dispatch/fallthrough
  // boundary. They are not represented by nodes inside IrBlock.
  exportedOutputs?: Iterable<ValueId>;
}>;

type BodyNodeSite = Readonly<{
  body: Body;
  nodeIndex: number;
  path: string;
}>;

type BodyOwner = Readonly<{
  body: Body;
  nodeIndex: number;
}>;

type LoopScope = Extract<
  NestedBody["scope"],
  { kind: "loop" }
>;

type BodyValidationContext = Readonly<{
  path: string;
  ownerOutput: ValueId | undefined;
  enclosingLoop: LoopScope | undefined;
}>;

type FunctionValidation = Readonly<{
  parameters: readonly ValueId[];
  parameterTypes: readonly ValueType[];
  results: readonly ValueType[];
}>;

export function validateIrBlock(
  block: IrBlock,
  options: ValidateIrBlockOptions = {}
): void {
  new IrValidator(block, undefined).validate(options);
}

export function validateIrFunction(fn: IrFunction): void {
  new IrValidator(fn, {
    parameters: fn.parameters,
    parameterTypes: fn.type.parameters,
    results: fn.type.results
  }).validate({});
}

// Validation has two phases. Indexing establishes the unique body tree and all
// scoped definitions; the semantic walk can then reject forward and escaping
// uses without depending on traversal order.
class IrValidator {
  readonly #block: IrBlock;
  readonly #bodyOwners = new Map<Body, BodyOwner | null>();
  readonly #producers = new Map<ValueId, BodyNodeSite>();
  readonly #loopInputs = new Map<ValueId, Body>();
  readonly #cellSeeds = new Map<CellRef, BodyNodeSite>();
  readonly #function: FunctionValidation | undefined;
  readonly #parameterValues = new Set<ValueId>();

  constructor(block: IrBlock, fn: FunctionValidation | undefined) {
    this.#block = block;
    this.#function = fn;
    this.#bodyOwners.set(block.body, null);
  }

  validate(options: ValidateIrBlockOptions): void {
    this.#validateParameters();
    this.#indexBody(this.#block.body, "body");
    this.#assertEveryNodeOutputHasProducer();
    this.#validateBody(this.#block.body, {
      path: "body",
      ownerOutput: undefined,
      enclosingLoop: undefined
    });
    this.#validateBoundaryOutputs(options.exportedOutputs ?? []);

    assert(
      bodyCompletes(this.#block.body) ||
        options.allowImplicitEntryFallthrough === true,
      "root body does not complete"
    );
  }

  // Phase 1 indexes producers and lexical definitions before checking uses.
  #indexBody(body: Body, path: string): void {
    for (const [nodeIndex, node] of body.nodes.entries()) {
      const site: BodyNodeSite = {
        body,
        nodeIndex,
        path: `${path}.${node.kind}[${nodeIndex}]`
      };

      this.#indexNodeDefinitions(node, site);
    }
  }

  #indexNodeDefinitions(node: BodyNode, site: BodyNodeSite): void {
    if (node.category === "operation") {
      this.#validateOperationDeclaration(node, site.path);
      this.#indexOperationOutputs(node, site);
      this.#indexCellDefinition(node, site);
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
      case "cell.read":
      case "cell.write":
        validateCellOperation(operation, path);
        return;
      case "resource.read":
      case "resource.write":
        validateResourceOperation(operation, path);
        return;
    }

    operation satisfies never;
  }

  #validateCallDeclaration(call: CallOperation, path: string): void {
    const parameterTypes = call.target.type.parameters;
    const resultTypes = call.target.type.results;

    assert(
      resultTypes.length <= 1,
      `${path} target has ${resultTypes.length} results; multiple call results are not supported yet`
    );

    assert(
      call.inputs.length === parameterTypes.length,
      `${path} passes ${call.inputs.length} arguments to ${parameterTypes.length} parameters`
    );
    for (const [index, input] of call.inputs.entries()) {
      const expected = parameterTypes[index];

      assert(expected !== undefined, `${path} has no parameter ${index}`);
      assert(
        input.type === expected,
        `${path} argument ${index} declares ${input.type}, expected ${expected}`
      );
    }
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
      call.directEffects === call.target.effects,
      `${path} effects do not match its call target`
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
      case "finish":
        assertNoControlResults(outputs, nestedBodies, path);
        assertSameValues(
          operands,
          [control.finish.kind === "exit"
            ? control.finish.result
            : control.finish.targetEip],
          `${path} operands do not match its finish value`
        );
        assertNoDirectEffects(directEffects, path);
        return;
      case "return":
        assertNoControlResults(outputs, nestedBodies, path);
        assertSameValues(
          operands,
          control.results,
          `${path} operands do not match its return results`
        );
        assertNoDirectEffects(directEffects, path);
        return;
      case "returnCall":
        validateReturnCallControlShape(
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
    site: BodyNodeSite
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

  #indexControlOutputs(control: Control, site: BodyNodeSite): void {
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
    body: Body,
    owner: BodyNodeSite,
    path: string
  ): void {
    this.#recordBodyOwner(body, owner, path);
    this.#indexBody(body, path);
  }

  #recordBodyOwner(body: Body, owner: BodyNodeSite, path: string): void {
    assert(
      !this.#bodyOwners.has(body),
      `${path} reuses a Body object that already has an owner`
    );
    this.#bodyOwners.set(body, {
      body: owner.body,
      nodeIndex: owner.nodeIndex
    });
  }

  // The seed write is the cell's declaration: the body holding it is the
  // cell's lexical scope, so scoping needs no identity beyond this site.
  #indexCellDefinition(operation: Operation, site: BodyNodeSite): void {
    if (
      operation.kind !== "cell.write" ||
      operation.initialization !== "seed"
    ) {
      return;
    }

    assert(
      !this.#cellSeeds.has(operation.cell),
      `${site.path} seeds the same cell more than once`
    );
    this.#cellSeeds.set(operation.cell, site);
  }

  #recordProducer(output: ValueId, site: BodyNodeSite): void {
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
    nested: NestedBody,
    site: BodyNodeSite
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
        `${site.path} reuses loop input ${input} across carried cells or loops`
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
  #validateBody(body: Body, context: BodyValidationContext): void {
    this.#validateBodyResult(body, context);

    for (const [nodeIndex, node] of body.nodes.entries()) {
      const site: BodyNodeSite = {
        body,
        nodeIndex,
        path: `${context.path}.${node.kind}[${nodeIndex}]`
      };

      this.#validateNode(node, site, context);

      if (node.completes({ bodyCompletes })) {
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

  #validateBodyResult(body: Body, context: BodyValidationContext): void {
    if (body.result !== undefined) {
      assert(
        context.ownerOutput !== undefined,
        `${context.path} carries a result without an owner output`
      );
      assert(!bodyCompletes(body), `${context.path} carries a result but completes`);
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
    node: BodyNode,
    site: BodyNodeSite,
    context: BodyValidationContext
  ): void {
    if (node.category === "operation") {
      this.#validateOperationInputs(node, site);
      this.#validateCellAccess(node, site);
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
      case "finish":
        this.#validateFinish(node, site.path);
        return;
      case "return":
        this.#validateReturn(node.results, site.path);
        return;
      case "returnCall":
        this.#validateReturnCall(node, site.path);
        return;
    }
  }

  #validateOperationInputs(
    operation: Operation,
    site: BodyNodeSite
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

  #validateCellAccess(operation: Operation, site: BodyNodeSite): void {
    if (operation.kind !== "cell.read" && operation.kind !== "cell.write") {
      return;
    }

    const seed = this.#cellSeeds.get(operation.cell);

    assert(seed !== undefined, `${site.path} uses a cell with no seed in this root`);
    if (operation.kind === "cell.write" && operation.initialization === "seed") {
      return;
    }
    this.#assertCellSeedDominates(seed, site);
  }

  #assertCellSeedDominates(seed: BodyNodeSite, use: BodyNodeSite): void {
    if (seed.body === use.body) {
      assert(
        seed.nodeIndex < use.nodeIndex,
        `${use.path} reads or writes a cell before its seed`
      );
      return;
    }

    for (let body = use.body; body !== seed.body; ) {
      const owner = this.#bodyOwners.get(body);

      assert(
        owner !== undefined && owner !== null,
        `${use.path} uses a cell outside its declaring body or descendants`
      );
      if (owner.body === seed.body) {
        assert(
          seed.nodeIndex < owner.nodeIndex,
          `${use.path} reads or writes a cell before its seed`
        );
        return;
      }
      body = owner.body;
    }
  }

  #validateLoopContinue(
    updates: readonly ValueId[],
    site: BodyNodeSite,
    context: BodyValidationContext
  ): void {
    const loop = context.enclosingLoop;

    assert(loop !== undefined, `${site.path} has a loopContinue outside any loop body`);
    assert(
      updates.length === loop.inputs.length,
      `${site.path} loopContinue updates do not align with the enclosing loop's carried cells`
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

  #validateFinish(
    control: Extract<Control, { kind: "finish" }>,
    path: string
  ): void {
    assert(this.#function === undefined, `${path} uses a block finish in a function`);

    switch (control.finish.kind) {
      case "dispatch":
        return;
      case "exit":
        assertValueType(this.#block, control.finish.result, "i64", `${path} exit result`);
        return;
    }
  }

  #validateNestedBodies(
    node: BodyNode,
    site: BodyNodeSite,
    context: BodyValidationContext
  ): void {
    const outputs = node.outputs;

    assert(outputs.length <= 1, `${site.path} has multiple nested-body outputs`);
    const ownerOutput = outputs[0];

    for (const nested of node.nestedBodies) {
      if (nested.scope.kind === "loop") {
        this.#validateBody(nested.body, {
          path: `${site.path}.${nested.role}`,
          ownerOutput: undefined,
          enclosingLoop: nested.scope
        });
      } else {
        this.#validateBody(nested.body, {
          path: `${site.path}.${nested.role}`,
          ownerOutput,
          enclosingLoop: context.enclosingLoop
        });
      }
    }
  }

  #validateValueUse(
    value: ValueId,
    site: BodyNodeSite,
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
    producer: BodyNodeSite,
    use: BodyNodeSite,
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
      const owner = this.#bodyOwners.get(body);

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

  #bodyIsWithin(body: Body, scope: Body): boolean {
    for (let current = body; ; ) {
      if (current === scope) {
        return true;
      }

      const owner = this.#bodyOwners.get(current);

      if (owner === undefined || owner === null) {
        return false;
      }
      current = owner.body;
    }
  }

  #validateBoundaryOutputs(outputs: Iterable<ValueId>): void {
    const nodeIndex = bodyCompletes(this.#block.body)
      ? this.#block.body.nodes.length - 1
      : this.#block.body.nodes.length;

    for (const output of outputs) {
      this.#validateValueUse(
        output,
        { body: this.#block.body, nodeIndex, path: "body boundary" },
        `exported output ${output}`
      );
    }
  }

  #validateParameters(): void {
    const fn = this.#function;

    if (fn === undefined) {
      for (let raw = 0; raw < this.#block.values.size(); raw += 1) {
        assert(
          this.#block.values.node(valueId(raw)).kind !== "parameter",
          `block body declares function parameter value ${raw}`
        );
      }
      return;
    }
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

  #validateReturn(results: readonly ValueId[], path: string): void {
    const fn = this.#function;

    assert(fn !== undefined, `${path} returns from a block body`);
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

  #validateReturnCall(control: ReturnCallControl, path: string): void {
    const fn = this.#function;

    assert(fn !== undefined, `${path} returns from a block body`);
    const targetResults = control.target.type.results;

    assert(
      targetResults.length === fn.results.length &&
        targetResults.every((type, index) => type === fn.results[index]),
      `${path} target results do not match the enclosing function`
    );
    for (const [index, input] of control.inputs.entries()) {
      const expected = control.target.type.parameters[index];

      assert(expected !== undefined, `${path} target has no parameter ${index}`);
      const actual = this.#block.values.valueType(input.value);

      assert(
        actual === expected,
        `${path} argument ${index} must be ${expected}, got ${actual}`
      );
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

function validateCellOperation(
  operation: CellReadOperation | CellWriteOperation,
  path: string
): void {
  assert(
    operation.referencedResources.length === 0,
    `${path} cell operation must not require resource bindings`
  );

  switch (operation.kind) {
    case "cell.read": {
      const result = operation.results[0];

      assert(operation.inputs.length === 0, `${path} must not have inputs`);
      assert(
        operation.results.length === 1 && result !== undefined,
        `${path} must have exactly one result`
      );
      assert(
        result.type === operation.cell.type,
        `${path} result type must match its cell`
      );
      assert(
        result.type !== "i32" || result.bounds === undefined,
        `${path} result must not refine its cell value bounds`
      );
      assert(
        operation.directEffects.reads.length === 1 &&
          isCellAccess(operation.directEffects.reads[0], operation.cell) &&
          operation.directEffects.writes.length === 0,
        `${path} effects must read its exact cell and write nothing`
      );
      return;
    }
    case "cell.write": {
      const input = operation.inputs[0];

      assert(
        operation.initialization === "seed" ||
          operation.initialization === "update",
        `${path} has an invalid cell-write initialization`
      );
      assert(
        operation.inputs.length === 1 &&
          input !== undefined &&
          input.value === operation.value &&
          input.type === operation.cell.type,
        `${path} must have exactly its cell-typed value input`
      );
      assert(operation.results.length === 0, `${path} must not have results`);
      assert(
        operation.directEffects.reads.length === 0 &&
          operation.directEffects.writes.length === 1 &&
          isCellAccess(operation.directEffects.writes[0], operation.cell),
        `${path} effects must write its exact cell and read nothing`
      );
      return;
    }
  }
}

function isCellAccess(
  access: StorageAccess | undefined,
  cell: CellRef
): boolean {
  return access?.space === "cell" && access.cell === cell;
}

function validateIfControlShape(
  control: IfControl,
  operands: readonly ValueId[],
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedBody[],
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
  nestedBodies: readonly NestedBody[],
  directEffects: StorageEffects,
  path: string
): void {
  assertSameValues(
    operands,
    [control.selector],
    `${path} operands do not match its selector`
  );
  assertSameValues(outputs, [control.output], `${path} outputs do not match its output field`);
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
  nestedBodies: readonly NestedBody[],
  directEffects: StorageEffects,
  block: IrBlock,
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
      `${path} carried cell ${index} seed and input types do not match`
    );
  }
  assertNoDirectEffects(directEffects, path);
}

function validateReturnCallControlShape(
  control: ReturnCallControl,
  operands: readonly ValueId[],
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedBody[],
  directEffects: StorageEffects,
  path: string
): void {
  assertNoControlResults(outputs, nestedBodies, path);
  assertSameValues(
    operands,
    control.inputs.map((input) => input.value),
    `${path} operands do not match its call inputs`
  );
  const parameters = control.target.type.parameters;

  assert(
    control.inputs.length === parameters.length,
    `${path} passes ${control.inputs.length} arguments to ${parameters.length} parameters`
  );
  for (const [index, input] of control.inputs.entries()) {
    const expected = parameters[index];

    assert(expected !== undefined, `${path} target has no parameter ${index}`);
    assert(
      input.type === expected,
      `${path} argument ${index} declares ${input.type}, expected ${expected}`
    );
  }
  assert(directEffects === control.target.effects, `${path} effects do not match its call target`);
  assert(
    control.completes({ bodyCompletes }),
    `${path} returnCall must complete its body`
  );
}

function assertNoControlResults(
  outputs: readonly ValueId[],
  nestedBodies: readonly NestedBody[],
  path: string
): void {
  assertNoOutputs(outputs, path);
  assert(nestedBodies.length === 0, `${path} must not have nested bodies`);
}

function assertNoOutputs(outputs: readonly ValueId[], path: string): void {
  assert(outputs.length === 0, `${path} must not have outputs`);
}

function assertOrdinaryBody(
  nested: NestedBody | undefined,
  body: Body,
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

function validateSwitchCases(control: SwitchControl, path: string): void {
  const seen = new Set<number>();

  for (const { match } of control.cases) {
    assert(
      Number.isInteger(match) && match >= 0 && match <= maxSwitchMatch,
      `${path} case match ${match} is not an integer in [0, ${maxSwitchMatch}]`
    );
    assert(!seen.has(match), `${path} has a duplicate case match ${match}`);
    seen.add(match);
  }
}

function assertValueType(
  block: IrBlock,
  value: ValueId,
  expected: ValueType,
  path: string
): void {
  const actual = block.values.valueType(value);

  assert(actual === expected, `${path} must be ${expected}, got ${actual}`);
}

function assertOutputBounds(
  block: IrBlock,
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
