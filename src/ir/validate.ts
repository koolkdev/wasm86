import { assert } from "#common/assert.js";
import {
  actionCompletes,
  bodyCompletes,
  maxSwitchMatch,
  type Action,
  type CallAction,
  type IfAction,
  type LoopAction,
  type OpAction,
  type SwitchAction
} from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import type { IrFunction } from "./function.js";
import type { OperationResult } from "#compiler/ir/operations/definition.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { CellRef } from "#compiler/refs/cell.js";
import {
  channelCovers,
  channelsOverlap,
  isDynamicSlot,
  type StateChannel,
  type StateSlot
} from "./slots.js";
import { actionOperands } from "./traverse.js";
import { unboundedWidthBounds } from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import {
  type ValueId,
  type ValueType,
  type WidthBounds
} from "#compiler/ir/values/types.js";

export type ValidateIrBlockOptions = Readonly<{
  allowImplicitEntryFallthrough?: boolean;
  // Values the embedder consumes at the root body's dispatch/fallthrough
  // boundary. They are not represented by actions inside IrBlock.
  exportedOutputs?: Iterable<ValueId>;
}>;

type ActionSite = Readonly<{
  body: Body;
  actionIndex: number;
  path: string;
}>;

type BodyOwner = Readonly<{
  body: Body;
  actionIndex: number;
}>;

type BodyValidationContext = Readonly<{
  path: string;
  ownerOutput: ValueId | undefined;
  enclosingLoop: LoopAction | undefined;
  hasPriorEipWrite: boolean;
}>;

type FunctionValidation = Readonly<{
  parameters: readonly ValueId[];
  parameterTypes: readonly ValueType[];
  results: readonly ValueType[];
}>;

// Structural checks: bodies terminate consistently, nested bodies are closed
// where their owner requires it, and dispatch targets are real values. A
// dispatch completion owns the architectural EIP commit, so state writes on
// the same path must not also flush EIP.
export function validateIrBlock(block: IrBlock, options: ValidateIrBlockOptions = {}): void {
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
  readonly #producers = new Map<ValueId, ActionSite>();
  readonly #loopInputs = new Map<ValueId, Body>();
  readonly #cellSeeds = new Map<CellRef, ActionSite>();
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
    this.#assertEveryActionOutputHasProducer();
    this.#validateBody(this.#block.body, {
      path: "body",
      ownerOutput: undefined,
      enclosingLoop: undefined,
      hasPriorEipWrite: false
    });
    this.#validateBoundaryOutputs(options.exportedOutputs ?? []);

    assert(
      bodyCompletes(this.#block.body) || options.allowImplicitEntryFallthrough === true,
      "root body does not complete"
    );
  }

  // Phase 1: index every nested body and record all scoped definitions.
  #indexBody(body: Body, path: string): void {
    for (const [actionIndex, action] of body.actions.entries()) {
      assertKnownAction(action);

      const site = {
        body,
        actionIndex,
        path: `${path}.${action.kind}[${actionIndex}]`
      };

      this.#indexActionDefinitions(action, site);
    }
  }

  #indexActionDefinitions(action: Action, site: ActionSite): void {
    switch (action.kind) {
      case "op":
        this.#indexOpProducer(action, site);
        this.#indexCellDefinition(action, site);
        return;
      case "call":
        this.#indexCallOutputs(action, site);
        return;
      case "if":
        if (action.output !== undefined) {
          this.#indexIfProducer(action, site);
        }
        this.#indexNestedBody(action.thenBody, site, `${site.path}.thenBody`);
        if (action.elseBody !== undefined) {
          this.#indexNestedBody(action.elseBody, site, `${site.path}.elseBody`);
        }
        return;
      case "switch":
        assert(action.defaultBody !== undefined, `${site.path} is missing its default body`);
        this.#indexSwitchProducer(action, site);
        for (const [caseIndex, switchCase] of action.cases.entries()) {
          this.#indexNestedBody(switchCase.body, site, `${site.path}.case[${caseIndex}]`);
        }
        this.#indexNestedBody(action.defaultBody, site, `${site.path}.default`);
        return;
      case "loop":
        this.#recordBodyOwner(action.body, site, `${site.path}.body`);
        this.#indexLoopInputs(action, site);
        this.#indexBody(action.body, `${site.path}.body`);
        return;
      case "loopContinue":
      case "finish":
      case "return":
        return;
    }
  }

  #indexNestedBody(body: Body, owner: ActionSite, path: string): void {
    this.#recordBodyOwner(body, owner, path);
    this.#indexBody(body, path);
  }

  #recordBodyOwner(body: Body, owner: ActionSite, path: string): void {
    assert(!this.#bodyOwners.has(body), `${path} reuses a Body object that already has an owner`);
    this.#bodyOwners.set(body, {
      body: owner.body,
      actionIndex: owner.actionIndex
    });
  }

  #indexOpProducer(action: OpAction, site: ActionSite): void {
    const operation = action.op;

    if (operation.result === undefined) {
      assert(action.output === undefined, `${action.op.kind} op action must not declare an output`);
      return;
    }

    assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
    assert(
      operation.effects.writes.length === 0,
      `${site.path} output-producing op has writes whose execute-when-dead semantics are not modeled`
    );
    for (const input of operation.inputs) {
      assert(
        input.value < action.output,
        `producer operand ${input.value} created after its output ${action.output}`
      );
    }
    this.#recordProducer(action.output, site);
  }

  #indexCallOutputs(action: CallAction, site: ActionSite): void {
    const resultTypes = action.target.type.results;

    assert(
      action.outputs.length === resultTypes.length,
      `${site.path} declares ${action.outputs.length} outputs for ${resultTypes.length} results`
    );
    assert(action.outputs.length <= 1, `${site.path} has unsupported multiple call outputs`);
    for (const [index, output] of action.outputs.entries()) {
      const expected = resultTypes[index];

      assert(expected !== undefined, `${site.path} has no result ${index}`);
      assert(
        this.#block.values.valueType(output) === expected,
        `${site.path} output ${index} must be ${expected}`
      );
      for (const argument of action.arguments) {
        assert(
          argument.value < output,
          `call argument ${argument.value} created after its output ${output}`
        );
      }
      this.#recordProducer(output, site);
    }
  }

  // The seed write is the cell's declaration: the body holding it is the
  // cell's lexical scope, so scoping needs no identity beyond this site.
  #indexCellDefinition(action: OpAction, site: ActionSite): void {
    const operation = action.op;

    if (operation.kind !== "cell.write" || operation.initialization !== "seed") {
      return;
    }

    assert(
      !this.#cellSeeds.has(operation.cell),
      `${site.path} seeds the same cell more than once`
    );
    this.#cellSeeds.set(operation.cell, site);
  }

  #indexSwitchProducer(action: SwitchAction, site: ActionSite): void {
    this.#recordProducer(action.output, site);
    assert(
      action.selector < action.output,
      `switch selector ${action.selector} created after its output ${action.output}`
    );

    for (const body of [...action.cases.map((switchCase) => switchCase.body), action.defaultBody]) {
      if (body.result !== undefined) {
        assert(
          body.result < action.output,
          `switch result ${body.result} created after its output ${action.output}`
        );
      }
    }
  }

  #indexIfProducer(action: IfAction, site: ActionSite): void {
    const output = action.output;

    assert(output !== undefined, `${site.path} value-producing if is missing its output`);
    assert(action.elseBody !== undefined, `${site.path} value-producing if is missing its else body`);
    this.#recordProducer(output, site);
    assert(
      action.condition < output,
      `if condition ${action.condition} created after its output ${output}`
    );

    for (const body of [action.thenBody, action.elseBody]) {
      if (body.result !== undefined) {
        assert(
          body.result < output,
          `if result ${body.result} created after its output ${output}`
        );
      }
    }
  }

  #recordProducer(output: ValueId, site: ActionSite): void {
    assert(
      this.#block.values.node(output).kind === "actionOutput",
      `${site.path} producer output ${output} is not an actionOutput value`
    );
    assert(!this.#producers.has(output), `action output ${output} has more than one producer`);
    this.#producers.set(output, site);
  }

  #indexLoopInputs(action: LoopAction, site: ActionSite): void {
    for (const cell of action.carried) {
      assert(
        this.#block.values.node(cell.loopInput).kind === "loopInput",
        `${site.path} carried cell input ${cell.loopInput} is not a loopInput value`
      );

      assert(
        !this.#loopInputs.has(cell.loopInput),
        `${site.path} reuses loop input ${cell.loopInput} across carried cells or loops`
      );
      this.#loopInputs.set(cell.loopInput, action.body);
    }
  }

  #assertEveryActionOutputHasProducer(): void {
    for (let rawId = 0; rawId < this.#block.values.size(); rawId += 1) {
      const id = valueId(rawId);

      if (this.#block.values.node(id).kind === "actionOutput") {
        assert(this.#producers.has(id), `action output ${id} has no producer`);
      }
    }
  }

  // A body carries a result exactly when its owner declares an output and the
  // body itself does not complete. `enclosingLoop` is the innermost loop whose
  // back edge a continue in this body would take.
  //
  // Phase 2: validate action semantics and every value use against phase 1.
  #validateBody(body: Body, context: BodyValidationContext): void {
    this.#validateBodyResult(body, context);

    let hasPriorEipWrite = context.hasPriorEipWrite;

    for (const [actionIndex, action] of body.actions.entries()) {
      const site = {
        body,
        actionIndex,
        path: `${context.path}.${action.kind}[${actionIndex}]`
      };

      this.#validateAction(action, site, context, hasPriorEipWrite);

      if (actionCompletes(action)) {
        assert(
          actionIndex === body.actions.length - 1,
          `${context.path} has actions after its terminal ${action.kind} action`
        );
      }

      this.#validateNestedBodies(action, site, context, hasPriorEipWrite);
      hasPriorEipWrite ||= actionWritesEip(action);
    }

    if (body.result !== undefined) {
      this.#validateValueUse(
        body.result,
        { body, actionIndex: body.actions.length, path: `${context.path} fallthrough` },
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

    // Escaping bodies under an output owner are model-valid but have no
    // producer yet; the emitter cannot lower them.
    assert(context.ownerOutput === undefined, `${context.path} must carry a result`);
  }

  #validateAction(
    action: Action,
    site: ActionSite,
    context: BodyValidationContext,
    hasPriorEipWrite: boolean
  ): void {
    if (action.kind === "op") {
      const operation = action.op;

      validateOpAction(this.#block, action, operation);
      this.#validateCellAccess(action, site);
      if (context.enclosingLoop !== undefined) {
        validateLoopStateAccess(operation, context.enclosingLoop, site.path);
      }

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
    } else if (action.kind === "call") {
      this.#validateCall(action, site);
    } else {
      for (const operand of actionOperands(action)) {
        this.#validateValueUse(operand, site, `${site.path} operand ${operand}`);
      }
    }

    switch (action.kind) {
      case "switch":
        validateSwitchCases(action, site.path);
        return;
      case "loop":
        validateLoopChannels(action, site.path);
        return;
      case "loopContinue":
        assert(
          context.enclosingLoop !== undefined,
          `${site.path} has a loopContinue outside any loop body`
        );
        assert(
          action.updates.length === context.enclosingLoop.carried.length,
          `${site.path} loopContinue updates do not align with the enclosing loop's carried cells`
        );
        return;
      case "finish":
        assert(this.#function === undefined, `${site.path} uses a block finish in a function`);
        if (action.finish.kind === "dispatch") {
          assert(!hasPriorEipWrite, `${context.path} dispatch path must not flush EIP state`);
        } else {
          assert(
            this.#block.values.valueType(action.finish.result) === "i64",
            `${site.path} exit result must be i64`
          );
        }
        return;
      case "return":
        this.#validateReturn(action.results, site.path);
        return;
      case "if":
      case "call":
      case "op":
        return;
    }
  }

  #validateCellAccess(action: OpAction, site: ActionSite): void {
    const operation = action.op;

    if (operation.kind !== "cell.read" && operation.kind !== "cell.write") {
      return;
    }

    const seed = this.#cellSeeds.get(operation.cell);

    assert(seed !== undefined, `${site.path} uses a cell with no seed in this root`);
    if (operation.kind === "cell.write" && operation.initialization === "seed") {
      // Phase 1 proved seed uniqueness, so this occurrence is the declaration.
      return;
    }
    this.#assertCellSeedDominates(seed, site);
  }

  #assertCellSeedDominates(seed: ActionSite, use: ActionSite): void {
    if (seed.body === use.body) {
      assert(
        seed.actionIndex < use.actionIndex,
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
          seed.actionIndex < owner.actionIndex,
          `${use.path} reads or writes a cell before its seed`
        );
        return;
      }
      body = owner.body;
    }
  }

  #validateNestedBodies(
    action: Action,
    site: ActionSite,
    context: BodyValidationContext,
    hasPriorEipWrite: boolean
  ): void {
    switch (action.kind) {
      case "if":
        this.#validateBody(action.thenBody, {
          path: `${site.path}.thenBody`,
          ownerOutput: action.output,
          enclosingLoop: context.enclosingLoop,
          hasPriorEipWrite
        });
        if (action.elseBody !== undefined) {
          this.#validateBody(action.elseBody, {
            path: `${site.path}.elseBody`,
            ownerOutput: action.output,
            enclosingLoop: context.enclosingLoop,
            hasPriorEipWrite
          });
        }
        return;
      case "switch":
        for (const [caseIndex, switchCase] of action.cases.entries()) {
          this.#validateBody(switchCase.body, {
            path: `${site.path}.case[${caseIndex}]`,
            ownerOutput: action.output,
            enclosingLoop: context.enclosingLoop,
            hasPriorEipWrite
          });
        }
        this.#validateBody(action.defaultBody, {
          path: `${site.path}.default`,
          ownerOutput: action.output,
          enclosingLoop: context.enclosingLoop,
          hasPriorEipWrite
        });
        return;
      case "loop":
        this.#validateBody(action.body, {
          path: `${site.path}.body`,
          ownerOutput: undefined,
          enclosingLoop: action,
          hasPriorEipWrite
        });
        return;
      case "op":
      case "call":
      case "loopContinue":
      case "finish":
      case "return":
        return;
    }
  }

  #validateValueUse(value: ValueId, site: ActionSite, path: string): void {
    const visited = new Set<ValueId>();

    const visit = (id: ValueId): void => {
      if (visited.has(id)) {
        return;
      }
      visited.add(id);

      const node = this.#block.values.node(id);

      switch (node.kind) {
        case "parameter":
          assert(
            this.#parameterValues.has(id),
            `function parameter ${id} is used outside its defining function at ${path}`
          );
          return;
        case "actionOutput": {
          const producer = this.#producers.get(id);

          assert(producer !== undefined, `action output ${id} used at ${path} has no producer`);
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
    producer: ActionSite,
    use: ActionSite,
    path: string
  ): void {
    if (producer.body === use.body) {
      assert(
        producer.actionIndex < use.actionIndex,
        `action output ${output} produced at ${producer.path} does not dominate ${path}`
      );
      return;
    }

    for (let body = use.body; body !== producer.body; ) {
      const owner = this.#bodyOwners.get(body);

      assert(
        owner !== undefined && owner !== null,
        `action output ${output} produced at ${producer.path} does not dominate ${path}`
      );

      if (owner.body === producer.body) {
        assert(
          producer.actionIndex < owner.actionIndex,
          `action output ${output} produced at ${producer.path} does not dominate ${path}`
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
    const actionIndex = bodyCompletes(this.#block.body)
      ? this.#block.body.actions.length - 1
      : this.#block.body.actions.length;

    for (const output of outputs) {
      this.#validateValueUse(
        output,
        { body: this.#block.body, actionIndex, path: "body boundary" },
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

  #validateCall(action: CallAction, site: ActionSite): void {
    const expected = action.target.type.parameters;

    assert(
      action.arguments.length === expected.length,
      `${site.path} passes ${action.arguments.length} arguments to ${expected.length} parameters`
    );
    for (const [index, argument] of action.arguments.entries()) {
      const parameterType = expected[index];

      assert(parameterType !== undefined, `${site.path} has no parameter ${index}`);
      assert(
        argument.type === parameterType,
        `${site.path} argument ${index} declares ${argument.type}, expected ${parameterType}`
      );
      const actual = this.#block.values.valueType(argument.value);

      assert(
        actual === parameterType,
        `${site.path} argument ${index} must be ${parameterType}, got ${actual}`
      );
      this.#validateValueUse(argument.value, site, `${site.path} argument ${index}`);
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
}

// A loop may carry nothing: a body advancing only semantic cells keeps all its
// cross-iteration state in cell locals.
function validateLoopChannels(action: LoopAction, path: string): void {
  for (const cell of action.carried) {
    assertCarriableChannel(cell.channel, path);
  }
}

// The state layer carries channels it can seed, read, and flush through
// exact accesses. GPR carries may be narrow, but loop bodies must touch them
// through the exact same alias.
function assertCarriableChannel(channel: StateChannel, path: string): void {
  switch (channel.kind) {
    case "gpr":
      return;
    case "instructionCount":
    case "lazyFlags":
      return;
    case "flag":
    case "segment":
    case "eip":
      assert(false, `${path} carries an unsupported ${channel.kind} channel`);
  }
}

function validateLoopStateAccess(operation: Operation, loop: LoopAction, path: string): void {
  for (const read of operation.effects.reads) {
    if (read.space === "state") {
      validateLoopStateSlotAccess(read.slot, "read", loop, path);
    }
  }

  for (const write of operation.effects.writes) {
    if (write.space === "state") {
      validateLoopStateSlotAccess(write.slot, "write", loop, path);
    }
  }
}

function validateLoopStateSlotAccess(
  slot: StateSlot,
  access: "read" | "write",
  loop: LoopAction,
  path: string
): void {
  const carriedChannels = loop.carried.map((cell) => cell.channel);

  if (isDynamicSlot(slot)) {
    assert(
      slot.kind !== "gprDynamic" || carriedChannels.every((channel) => channel.kind !== "gpr"),
      `${path} loop body ${access} uses a dynamic GPR slot with carried GPR state`
    );
    return;
  }

  for (const carried of carriedChannels) {
    assert(
      !channelsOverlap(carried, slot) ||
        (channelCovers(carried, slot) && channelCovers(slot, carried)),
      `${path} loop body ${access} partially overlaps a carried channel`
    );
  }
}

function validateSwitchCases(action: SwitchAction, path: string): void {
  const seen = new Set<number>();

  for (const { match } of action.cases) {
    assert(
      Number.isInteger(match) && match >= 0 && match <= maxSwitchMatch,
      `${path} case match ${match} is not an integer in [0, ${maxSwitchMatch}]`
    );
    assert(!seen.has(match), `${path} has a duplicate case match ${match}`);
    seen.add(match);
  }
}

function validateOpAction(block: IrBlock, action: OpAction, operation: Operation): void {
  if (operation.result === undefined) {
    return;
  }

  assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
  assert(
    block.values.valueType(action.output) === operation.result.type,
    `${action.op.kind} op action output ${action.output} has the wrong value type`
  );
  assertOutputBounds(block, action, action.output, operation.result);
}

function assertOutputBounds(
  block: IrBlock,
  action: OpAction,
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
    `${action.op.kind} op action output ${output} has the wrong bounds: expected ${formatBounds(expectedBounds)}, got ${formatBounds(actualBounds)}`
  );
}

function boundsEqual(a: WidthBounds, b: WidthBounds): boolean {
  return a.unsignedBits === b.unsignedBits && a.signedBits === b.signedBits;
}

function formatBounds(bounds: WidthBounds): string {
  return `{ unsignedBits: ${bounds.unsignedBits}, signedBits: ${bounds.signedBits} }`;
}

function assertKnownAction(action: Action): void {
  const kind = (action as { kind?: unknown }).kind;

  assert(
    kind === "op" ||
      kind === "call" ||
      kind === "if" ||
      kind === "switch" ||
      kind === "loop" ||
      kind === "loopContinue" ||
      kind === "finish" ||
      kind === "return",
    `unknown IR action kind ${String(kind)}`
  );
}

function actionWritesEip(action: Action): boolean {
  return action.kind === "op" && action.op.effects.writes.some(
    (write) => write.space === "state" && write.slot.kind === "eip"
  );
}
