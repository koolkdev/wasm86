import { assert } from "#common/assert.js";
import {
  actionCompletes,
  bodyCompletes,
  maxSwitchMatch,
  type Action,
  type Finish,
  type IrExit,
  type LoopAction,
  type OpAction,
  type StateWriteAction,
  type SwitchAction
} from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import { opAccess, type OpValueOutput } from "./ops.js";
import {
  channelCovers,
  channelsOverlap,
  isDynamicSlot,
  type StateChannel,
  type StateSlot
} from "./slots.js";
import { unboundedWidthBounds, type ValueId, type WidthBounds } from "./values.js";

export type ValidateIrBlockOptions = Readonly<{
  allowImplicitEntryFallthrough?: boolean;
}>;

// Structural checks: bodies terminate consistently, nested bodies are closed
// where their owner requires it, and dispatch targets are real values. A
// dispatch completion owns the architectural EIP commit, so state writes on
// the same path must not also flush EIP.
export function validateIrBlock(block: IrBlock, options: ValidateIrBlockOptions = {}): void {
  validateBody(block, block.body, [], "body", undefined, undefined);

  assert(
    bodyCompletes(block.body) || options.allowImplicitEntryFallthrough === true,
    "root body does not complete"
  );
}

// A body carries a result exactly when its owner declares an output
// (`ownerOutput`) and the body itself does not complete. `enclosingLoop` is
// the innermost loop whose back edge a continue in this body would take.
function validateBody(
  block: IrBlock,
  body: Body,
  ancestorPrefix: readonly Action[],
  path: string,
  ownerOutput: ValueId | undefined,
  enclosingLoop: LoopAction | undefined
): void {
  if (body.result !== undefined) {
    assert(ownerOutput !== undefined, `${path} carries a result without an owner output`);
    assert(!bodyCompletes(body), `${path} carries a result but completes`);
    assert(
      block.values.valueType(body.result) === block.values.valueType(ownerOutput),
      `${path} result type does not match its owner output`
    );
  } else {
    // Escaping bodies under an output owner are model-valid but have no
    // producer yet; the emitter cannot lower them.
    assert(ownerOutput === undefined, `${path} must carry a result`);
  }

  for (const [index, action] of body.actions.entries()) {
    assertKnownAction(action);
    validateActionValues(block, action);
    if (action.kind === "op" && enclosingLoop !== undefined) {
      validateLoopStateAccess(action, enclosingLoop, `${path}.op[${index}]`);
    }

    // Structural before completion: actionCompletes walks the default body.
    if (action.kind === "switch") {
      validateSwitchCases(action, `${path}.switch[${index}]`);
    }

    if (actionCompletes(action)) {
      assert(
        index === body.actions.length - 1,
        `${path} has actions after its terminal ${action.kind} action`
      );
    }

    let prefix: readonly Action[] | undefined;
    const prefixBeforeAction = () => {
      prefix ??= [
        ...ancestorPrefix,
        ...body.actions.slice(0, index)
      ];
      return prefix;
    };

    switch (action.kind) {
      case "if":
        validateBody(block, action.thenBody, prefixBeforeAction(), `${path}.if[${index}].thenBody`, undefined, enclosingLoop);

        if (action.elseBody !== undefined) {
          validateBody(block, action.elseBody, prefixBeforeAction(), `${path}.if[${index}].elseBody`, undefined, enclosingLoop);
        }

        break;
      case "switch": {
        for (const [caseIndex, switchCase] of action.cases.entries()) {
          validateBody(
            block,
            switchCase.body,
            prefixBeforeAction(),
            `${path}.switch[${index}].case[${caseIndex}]`,
            action.output,
            enclosingLoop
          );
        }

        validateBody(
          block,
          action.defaultBody,
          prefixBeforeAction(),
          `${path}.switch[${index}].default`,
          action.output,
          enclosingLoop
        );
        break;
      }
      case "loop":
        validateLoopCells(block, action, `${path}.loop[${index}]`);
        validateBody(block, action.body, prefixBeforeAction(), `${path}.loop[${index}].body`, undefined, action);
        break;
      case "loopContinue":
        assert(enclosingLoop !== undefined, `${path} has a loopContinue outside any loop body`);
        assert(
          action.updates.length === enclosingLoop.carried.length,
          `${path} loopContinue updates do not align with the enclosing loop's carried cells`
        );
        break;
      case "finish":
        if (action.finish.kind === "dispatch") {
          assertDispatchDoesNotFlushEip(prefixBeforeAction(), path);
        }

        break;
      case "op":
        break;
    }
  }
}

function validateLoopCells(block: IrBlock, action: LoopAction, path: string): void {
  assert(action.carried.length > 0, `${path} carries no cells`);

  const seen = new Set<ValueId>();

  for (const cell of action.carried) {
    block.values.node(cell.seed);
    assert(
      block.values.node(cell.loopInput).kind === "loopInput",
      `${path} carried cell input ${cell.loopInput} is not a loopInput value`
    );
    assert(!seen.has(cell.loopInput), `${path} reuses loop input ${cell.loopInput} across carried cells`);
    seen.add(cell.loopInput);

    if (cell.channel !== undefined) {
      assertCarriableChannel(cell.channel, path);
    }
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

function validateLoopStateAccess(action: OpAction, loop: LoopAction, path: string): void {
  const access = opAccess(action.op);

  for (const read of access.reads) {
    if (read.space === "state") {
      validateLoopStateSlotAccess(read.slot, "read", loop, path);
    }
  }

  for (const write of access.writes) {
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
  const carriedChannels = loop.carried.flatMap((cell) => cell.channel === undefined ? [] : [cell.channel]);

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

function validateActionValues(block: IrBlock, action: Action): void {
  switch (action.kind) {
    case "op":
      validateOpActionValues(block, action);
      return;
    case "if":
      block.values.node(action.condition);
      return;
    case "switch":
      block.values.node(action.selector);
      block.values.node(action.output);
      return;
    case "loop":
      return;
    case "loopContinue":
      for (const update of action.updates) {
        block.values.node(update);
      }
      return;
    case "finish":
      validateFinishValues(block, action.finish);
      return;
  }
}

function validateSwitchCases(action: SwitchAction, path: string): void {
  assert(action.defaultBody !== undefined, `${path} is missing its default body`);

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

function validateFinishValues(block: IrBlock, finish: Finish): void {
  switch (finish.kind) {
    case "dispatch":
      block.values.node(finish.targetEip);
      return;
    case "exit":
      validateExitValues(block, finish.exit);
      return;
  }
}

function validateExitValues(block: IrBlock, exit: IrExit): void {
  switch (exit.class) {
    case "cpuException": {
      const exception = exit.exception;

      switch (exception.kind) {
        case "DE":
          return;
        case "PF":
          block.values.node(exception.linearAddress);
          return;
      }
      return;
    }
    case "host":
      if (exit.payload !== undefined) {
        block.values.node(exit.payload);
      }
      return;
  }
}

function validateOpActionValues(block: IrBlock, action: OpAction): void {
  const access = opAccess(action.op);

  for (const input of access.valueInputs) {
    block.values.node(input);
  }

  if (access.valueOutput === undefined) {
    assert(action.output === undefined, `${action.op.kind} op action must not declare an output`);
    return;
  }

  assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
  block.values.node(action.output);
  assert(
    block.values.valueType(action.output) === access.valueOutput.type,
    `${action.op.kind} op action output ${action.output} has the wrong value type`
  );
  assertOutputBounds(block, action, action.output, access.valueOutput);
}

function assertOutputBounds(
  block: IrBlock,
  action: OpAction,
  output: ValueId,
  expected: OpValueOutput
): void {
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

function assertDispatchDoesNotFlushEip(prefix: readonly Action[], path: string): void {
  const eipWrite = lastEipWrite(prefix);

  assert(eipWrite === undefined, `${path} dispatch path must not flush EIP state`);
}

function assertKnownAction(action: Action): void {
  const kind = (action as { kind?: unknown }).kind;

  assert(
    kind === "op" ||
      kind === "if" ||
      kind === "switch" ||
      kind === "loop" ||
      kind === "loopContinue" ||
      kind === "finish",
    `unknown IR action kind ${String(kind)}`
  );
}

function lastEipWrite(actions: readonly Action[]): StateWriteAction | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;

    if (isStateWriteAction(action) && action.op.slot.kind === "eip") {
      return action;
    }
  }

  return undefined;
}

function isStateWriteAction(action: Action): action is StateWriteAction {
  return action.kind === "op" && action.op.kind === "state.write";
}
