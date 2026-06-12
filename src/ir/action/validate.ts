import { assert } from "#common/assert.js";
import type { Action, ActionBlock, EntryRegion, RegionId } from "./types.js";

// Structural checks: regions terminate exactly once and every region
// reference resolves.

export function validateActionBlock(block: ActionBlock): void {
  const edgeIds = new Set<RegionId>();
  let entry: EntryRegion | undefined;

  for (const region of block.regions) {
    switch (region.kind) {
      case "entry":
        assert(entry === undefined, "action block has more than one entry region");
        entry = region;
        break;
      case "edge":
        edgeIds.add(region.id);
        break;
    }
  }

  assert(entry !== undefined && entry.id === block.entry, "action block entry region is missing");
  assert(edgeIds.size + 1 === block.regions.length, "action block region ids are not unique");
  assert(!edgeIds.has(entry.id), "action block region ids are not unique");

  validateEntryActions(entry, edgeIds);
}

// Branch, exit, and continue are region terminators; edge bodies always
// branch off the entry, so every edge is targeted by exactly one guard or
// branch.
function validateEntryActions(entry: EntryRegion, edgeIds: ReadonlySet<RegionId>): void {
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
