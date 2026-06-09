import { channelsOverlap } from "#ir/action/slots.js";
import type { Action, ActionRegion } from "#ir/action/types.js";
import type { ValueId, ValueNode, ValueTable } from "#ir/action/values.js";

// Pure per-region value analysis for the action emitter: everything is
// decided up front from the action list and the value graph. No encoder
// imports — the materializer consumes this, the analysis never emits.

export type RegionValueAnalysis = Readonly<{
  // Emission uses: action-operand edges plus the child edges of every
  // reachable compound, counted once per parent — a multi-use compound
  // computes once and replays from a local, so its children are not
  // consumed again.
  useCount(id: ValueId): number;
  // Action index of the last point the value is pushed onto the stack:
  // direct operand uses, plus the first use of each reachable parent (a
  // compound computes at its first use).
  lastUse(id: ValueId): number | undefined;
  // readState outputs that must be captured to a local at their action
  // point: a load at use would observe a later overlapping store.
  isPinned(id: ValueId): boolean;
}>;

export function analyzeRegionValues(region: ActionRegion, values: ValueTable): RegionValueAnalysis {
  const useCounts = new Map<ValueId, number>();
  const firstUses = new Map<ValueId, number>();
  const lastUses = new Map<ValueId, number>();

  function addUse(id: ValueId, actionIndex: number): void {
    useCounts.set(id, (useCounts.get(id) ?? 0) + 1);
    firstUses.set(id, Math.min(firstUses.get(id) ?? actionIndex, actionIndex));
    lastUses.set(id, Math.max(lastUses.get(id) ?? actionIndex, actionIndex));
  }

  region.actions.forEach((action, actionIndex) => {
    for (const operand of actionOperands(action)) {
      addUse(operand, actionIndex);
    }
  });

  // Children always have lower ids than their parents, so a descending walk
  // sees each parent's uses settled before charging its child edges. A used
  // compound computes once, at its first use — that is where its children
  // are consumed, no matter how often the compound itself is replayed.
  for (let id = values.size() - 1; id >= 0; id -= 1) {
    if ((useCounts.get(id) ?? 0) === 0) {
      continue;
    }

    const computedAt = firstUses.get(id)!;

    for (const child of valueChildren(values.node(id))) {
      addUse(child, computedAt);
    }
  }

  // The one ordering rule: a readState whose value is consumed past a
  // may-aliasing store pins at its action point. While stores are static
  // channels, byte-range overlap is the whole aliasing story; switch to the
  // derived mayAlias once writeMemory/dynamic slots exist (05/07).
  const pinned = new Set<ValueId>();

  region.actions.forEach((action, actionIndex) => {
    if (action.kind !== "readState") {
      return;
    }

    const lastUse = lastUses.get(action.output);

    if (lastUse === undefined) {
      return;
    }

    // An operand of the store action itself is pushed before the store
    // executes, so a use at the store's own index stays safe.
    for (let index = actionIndex + 1; index < lastUse; index += 1) {
      const later = region.actions[index]!;

      if (later.kind === "writeState" && channelsOverlap(later.slot, action.slot)) {
        pinned.add(action.output);
        break;
      }
    }
  });

  return {
    useCount(id: ValueId): number {
      values.node(id);
      return useCounts.get(id) ?? 0;
    },
    lastUse(id: ValueId): number | undefined {
      values.node(id);
      return lastUses.get(id);
    },
    isPinned(id: ValueId): boolean {
      values.node(id);
      return pinned.has(id);
    }
  };
}

function actionOperands(action: Action): readonly ValueId[] {
  switch (action.kind) {
    case "readState":
      return [];
    case "readMemory":
      return [action.address];
    case "writeState":
      return [action.value];
    case "writeMemory":
      return [action.address, action.value];
    case "guardMemory":
      return [action.address];
    case "branch":
      return [action.condition];
    case "exit":
      return action.payload === undefined ? [] : [action.payload];
  }
}

function valueChildren(node: ValueNode): readonly ValueId[] {
  switch (node.kind) {
    case "const":
    case "actionOutput":
    case "external":
      return [];
    case "binary":
    case "compare":
      return [node.a, node.b];
    case "unary":
    case "project":
      return [node.value];
    case "select":
      return [node.condition, node.whenTrue, node.whenFalse];
  }
}
