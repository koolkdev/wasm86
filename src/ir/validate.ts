import { assert } from "#common/assert.js";
import {
  actionCompletes,
  bodyFinal,
  bodyCompletes,
  type Action,
  type DispatchFinish,
  type Finish,
  type OpAction,
  type StateWriteAction
} from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import { opAccess, type OpValueOutput } from "./ops.js";
import { unboundedWidthBounds, type WidthBounds } from "./values.js";

export type ValidateIrBlockOptions = Readonly<{
  allowImplicitEntryFallthrough?: boolean;
}>;

// Structural checks: bodies terminate consistently, nested bodies are closed
// where their owner requires it, and dispatch targets are real values with
// matching EIP commits on every path that dispatches.
export function validateIrBlock(block: IrBlock, options: ValidateIrBlockOptions = {}): void {
  validateBody(block, block.body, [], "body");

  assert(
    bodyCompletes(block.body) || options.allowImplicitEntryFallthrough === true,
    "root body does not complete"
  );
}

function validateBody(
  block: IrBlock,
  body: Body,
  ancestorPrefix: readonly Action[],
  path: string
): void {
  for (const [index, action] of body.actions.entries()) {
    assertKnownAction(action);
    validateActionValues(block, action);

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
      case "guardMemory":
        validateBody(block, action.faultBody, prefixBeforeAction(), `${path}.guardMemory[${index}].faultBody`);
        assert(
          bodyCompletes(action.faultBody),
          `${path}.guardMemory[${index}].faultBody does not complete`
        );
        assertGuardFaultBodyExits(action.faultBody, action.byteLength, `${path}.guardMemory[${index}].faultBody`);
        break;
      case "if":
        validateBody(block, action.thenBody, prefixBeforeAction(), `${path}.if[${index}].thenBody`);

        if (action.elseBody !== undefined) {
          validateBody(block, action.elseBody, prefixBeforeAction(), `${path}.if[${index}].elseBody`);
        }

        break;
      case "finish":
        if (action.finish.kind === "dispatch") {
          assertDispatchEipFlushed(prefixBeforeAction(), action.finish, path);
        }

        break;
      case "op":
        break;
    }
  }
}

function assertGuardFaultBodyExits(body: Body, byteLength: number, path: string): void {
  const final = bodyFinal(body);

  assert(
    final?.kind === "finish" && final.finish.kind === "exit",
    `${path} must terminate with exit`
  );
  assert(
    final.finish.detail === byteLength,
    `${path} exit detail must match guard byte length`
  );
}

function validateActionValues(block: IrBlock, action: Action): void {
  switch (action.kind) {
    case "op":
      validateOpActionValues(block, action);
      return;
    case "guardMemory":
      block.values.node(action.address);
      return;
    case "if":
      block.values.node(action.condition);
      return;
    case "finish":
      validateFinishValues(block, action.finish);
      return;
  }
}

function validateFinishValues(block: IrBlock, finish: Finish): void {
  switch (finish.kind) {
    case "dispatch":
      block.values.node(finish.targetEip);
      return;
    case "exit":
      if (finish.payload !== undefined) {
        block.values.node(finish.payload);
      }
      if (finish.detail !== undefined) {
        assert(
          Number.isInteger(finish.detail) && finish.detail >= 0 && finish.detail <= 0xffff,
          `exit detail out of range: ${finish.detail}`
        );
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
  output: number,
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

function assertDispatchEipFlushed(
  prefix: readonly Action[],
  dispatch: DispatchFinish,
  path: string
): void {
  const eipWrite = lastEipWrite(prefix);

  assert(eipWrite !== undefined, `${path} dispatch path must flush EIP state`);
  assert(eipWrite.op.value === dispatch.targetEip, `${path} dispatch EIP flush does not match dispatch.targetEip`);
}

function assertKnownAction(action: Action): void {
  const kind = (action as { kind?: unknown }).kind;

  assert(
    kind === "op" ||
      kind === "guardMemory" ||
      kind === "if" ||
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
