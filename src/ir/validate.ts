import { assert } from "#common/assert.js";
import type { Action } from "./actions.js";
import type { EdgeRegion, EntryRegion, IrBlock, IrRegion, RegionId } from "./block.js";
import type { ValueId } from "./values.js";

// Structural checks: regions terminate exactly once, every region reference
// resolves, and cached continuations match the flushes.

export function validateIrBlock(block: IrBlock): void {
  const edgeIds = new Set<RegionId>();
  const edgeById = new Map<RegionId, EdgeRegion>();
  let entry: EntryRegion | undefined;

  for (const region of block.regions) {
    assert(
      region.continuation === continuationOf(region),
      `region ${region.id} continuation does not match its flushed eip`
    );

    switch (region.kind) {
      case "entry":
        assert(entry === undefined, "IR block has more than one entry region");
        entry = region;
        break;
      case "edge":
        edgeIds.add(region.id);
        edgeById.set(region.id, region);
        break;
    }
  }

  assert(entry !== undefined && entry.id === block.entry, "IR block entry region is missing");
  assert(edgeIds.size + 1 === block.regions.length, "IR block region ids are not unique");
  assert(!edgeIds.has(entry.id), "IR block region ids are not unique");

  validateEntryActions(entry, edgeIds, edgeById);
}

// Branch, exit, and continue are region terminators; edge bodies always
// branch off the entry, so every edge is targeted by exactly one guard or
// branch.
function validateEntryActions(
  entry: EntryRegion,
  edgeIds: ReadonlySet<RegionId>,
  edgeById: ReadonlyMap<RegionId, EdgeRegion>
): void {
  const targeted = new Set<RegionId>();

  function target(edge: RegionId, by: Action["kind"]): void {
    assert(edgeIds.has(edge), `${by} targets unknown edge region ${edge}`);
    assert(!targeted.has(edge), `edge region ${edge} is targeted more than once`);
    targeted.add(edge);
  }

  for (const [index, action] of entry.actions.entries()) {
    if (isRegionTerminator(action)) {
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
      case "readState":
      case "readMemory":
      case "writeState":
      case "writeMemory":
      case "exit":
      case "continue":
        break;
    }
  }

  const last = entry.actions[entry.actions.length - 1];

  assert(last !== undefined && isRegionTerminator(last), "entry region does not end with a terminator");

  for (const id of edgeIds) {
    assert(targeted.has(id), `edge region ${id} is not targeted by any entry action`);
  }
}

function isRegionTerminator(action: Action): boolean {
  switch (action.kind) {
    case "branch":
    case "exit":
    case "continue":
      return true;
    case "readState":
    case "readMemory":
    case "writeState":
    case "writeMemory":
    case "guardMemory":
      return false;
  }
}

function continuationOf(region: IrRegion): ValueId | undefined {
  switch (region.kind) {
    case "entry": {
      const terminator = region.actions[region.actions.length - 1];

      return terminator !== undefined && terminator.kind === "continue"
        ? flushedEip(region.actions)
        : undefined;
    }
    case "edge":
      switch (region.terminator.kind) {
        case "continue":
          return flushedEip(region.flushes);
        case "exit":
          return undefined;
      }
  }
}

function flushedEip(actions: readonly Action[]): ValueId | undefined {
  let flushed: ValueId | undefined;

  for (const action of actions) {
    if (action.kind === "writeState" && action.slot.kind === "eip") {
      flushed = action.value;
    }
  }

  return flushed;
}
