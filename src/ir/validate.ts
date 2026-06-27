import { assert } from "#common/assert.js";
import { isTerminatorAction, type Action, type DispatchAction, type ExitAction } from "./actions.js";
import type { EdgeRegion, EntryRegion, IrBlock, IrRegion, RegionId } from "./block.js";

export type ValidateIrBlockOptions = Readonly<{
  allowImplicitEntryFallthrough?: boolean;
}>;

// Structural checks: regions terminate consistently, every region reference
// resolves, dispatch targets are real values with matching EIP commits, and
// legacy continuation/continue shapes are rejected at runtime even if a
// caller bypasses TypeScript.
export function validateIrBlock(block: IrBlock, options: ValidateIrBlockOptions = {}): void {
  const edgeIds = new Set<RegionId>();
  const edgeById = new Map<RegionId, EdgeRegion>();
  let entry: EntryRegion | undefined;

  for (const region of block.regions) {
    assertNoContinuationField(region);

    switch (region.kind) {
      case "entry":
        assert(entry === undefined, "IR block has more than one entry region");
        entry = region;
        break;
      case "edge":
        validateEdgeTerminator(block, region.terminator);
        validateEdgeFlushes(block, region);
        edgeIds.add(region.id);
        edgeById.set(region.id, region);
        break;
    }
  }

  assert(entry !== undefined && entry.id === block.entry, "IR block entry region is missing");
  assert(edgeIds.size + 1 === block.regions.length, "IR block region ids are not unique");
  assert(!edgeIds.has(entry.id), "IR block region ids are not unique");

  validateEntryActions(block, entry, edgeIds, edgeById, options);
}

// Branch, exit, and dispatch are closed-region terminators; edge bodies
// always branch off the entry, so every edge is targeted by exactly one guard
// or branch.
function validateEntryActions(
  block: IrBlock,
  entry: EntryRegion,
  edgeIds: ReadonlySet<RegionId>,
  edgeById: ReadonlyMap<RegionId, EdgeRegion>,
  options: ValidateIrBlockOptions
): void {
  const targeted = new Set<RegionId>();

  function target(edge: RegionId, by: Action["kind"]): void {
    assert(edgeIds.has(edge), `${by} targets unknown edge region ${edge}`);
    assert(!targeted.has(edge), `edge region ${edge} is targeted more than once`);
    targeted.add(edge);
  }

  for (const [index, action] of entry.actions.entries()) {
    assertKnownEntryAction(action);
    validateActionValues(block, action);

    if (isTerminatorAction(action)) {
      assert(
        index === entry.actions.length - 1,
        `entry region continues after its ${action.kind} terminator`
      );
    }

    switch (action.kind) {
      case "guardMemory":
        target(action.faultEdge, action.kind);
        assert(
          edgeById.get(action.faultEdge)?.terminator.kind === "exit",
          `guardMemory fault edge ${action.faultEdge} must terminate with exit`
        );
        break;
      case "branch":
        target(action.taken, action.kind);
        target(action.notTaken, action.kind);
        break;
      case "dispatch":
        assertEntryDispatchEipFlushed(entry.actions, index, action);
        break;
      case "readState":
      case "readMemory":
      case "writeState":
      case "writeMemory":
      case "exit":
        break;
    }
  }

  const last = entry.actions[entry.actions.length - 1];

  assert(
    (last !== undefined && isTerminatorAction(last)) || options.allowImplicitEntryFallthrough === true,
    "entry region does not end with a terminator"
  );

  for (const id of edgeIds) {
    assert(targeted.has(id), `edge region ${id} is not targeted by any entry action`);
  }
}

function validateEdgeTerminator(block: IrBlock, terminator: EdgeRegion["terminator"]): void {
  assertKnownEdgeTerminator(terminator);

  switch (terminator.kind) {
    case "dispatch":
      block.values.node(terminator.targetEip);
      return;
    case "exit":
      if (terminator.payload !== undefined) {
        block.values.node(terminator.payload);
      }
      return;
  }
}

function validateEdgeFlushes(block: IrBlock, edge: EdgeRegion): void {
  for (const flush of edge.flushes) {
    block.values.node(flush.value);
  }

  if (edge.terminator.kind === "dispatch") {
    const eipFlush = lastEipWrite(edge.flushes);

    assert(eipFlush !== undefined, `dispatch edge ${edge.id} must flush EIP state`);
    assert(
      eipFlush.value === edge.terminator.targetEip,
      `dispatch edge ${edge.id} EIP flush does not match dispatch.targetEip`
    );
  }
}

function validateActionValues(block: IrBlock, action: Action): void {
  switch (action.kind) {
    case "readState":
      block.values.node(action.output);
      return;
    case "readMemory":
      block.values.node(action.output);
      block.values.node(action.address);
      return;
    case "writeState":
      block.values.node(action.value);
      return;
    case "writeMemory":
      block.values.node(action.address);
      block.values.node(action.value);
      return;
    case "guardMemory":
      block.values.node(action.address);
      return;
    case "branch":
      block.values.node(action.condition);
      return;
    case "exit":
      if (action.payload !== undefined) {
        block.values.node(action.payload);
      }
      return;
    case "dispatch":
      block.values.node(action.targetEip);
      return;
  }
}

function assertEntryDispatchEipFlushed(
  actions: readonly Action[],
  dispatchIndex: number,
  dispatch: DispatchAction
): void {
  const previous = actions.slice(0, dispatchIndex);
  const eipWrite = lastEipWrite(previous);

  assert(eipWrite !== undefined, "dispatch entry path must flush EIP state");
  assert(eipWrite.value === dispatch.targetEip, "dispatch entry EIP flush does not match dispatch.targetEip");
}

function assertNoContinuationField(region: IrRegion): void {
  assert(
    !Object.prototype.hasOwnProperty.call(region, "continuation"),
    `region ${region.id} continuation fields are no longer supported`
  );
}

function assertKnownEntryAction(action: Action): void {
  const kind = (action as { kind?: unknown }).kind;

  assert(kind !== "continue", "continue action is no longer supported; use dispatch(targetEip)");
  assert(
    kind === "readState" ||
      kind === "readMemory" ||
      kind === "writeState" ||
      kind === "writeMemory" ||
      kind === "guardMemory" ||
      kind === "branch" ||
      kind === "exit" ||
      kind === "dispatch",
    `unknown IR action kind ${String(kind)}`
  );
}

function assertKnownEdgeTerminator(terminator: ExitAction | DispatchAction): void {
  const kind = (terminator as { kind?: unknown }).kind;

  assert(kind !== "continue", "continue action is no longer supported; use dispatch(targetEip)");
  assert(kind === "exit" || kind === "dispatch", `edge region terminator must be dispatch or exit, got ${String(kind)}`);
}

function lastEipWrite(actions: readonly Action[]): Extract<Action, { kind: "writeState" }> | undefined {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;

    if (action.kind === "writeState" && action.slot.kind === "eip") {
      return action;
    }
  }

  return undefined;
}
