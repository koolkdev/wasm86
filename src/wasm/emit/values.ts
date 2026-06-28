import { assert } from "#common/assert.js";
import { actionMayWriteStateSlot } from "#ir/aliasing.js";
import { isTerminatorAction, type Action, type ReadStateAction, type StateSlot } from "#ir/actions.js";
import type {
  IrBlock,
  EdgeRegion,
  EntryRegion,
  RegionId
} from "#ir/block.js";
import type { ValueId, ValueNode, ValueTable } from "#ir/values.js";

// Pure value analysis for the action emitter: everything is decided up front
// from the action lists and the value graph. No encoder imports — the value
// stack consumes this, the analysis never emits.

export type BlockValueAnalysis = Readonly<{
  // Emission uses: action-operand edges plus the child edges of every
  // reachable compound, counted once per parent.
  useCount(id: ValueId): number;
  // Entry action index of the last point the value is pushed onto the
  // stack: direct operand uses, plus the first use of each reachable
  // parent; edge uses count at their guard's index.
  lastUse(id: ValueId): number | undefined;
  // readState outputs that must be captured to a local at their action
  // point: a load at use would observe a later overlapping store.
  isPinned(id: ValueId): boolean;
}>;

export function analyzeBlockValues(
  block: IrBlock,
  exportedOutputs: Iterable<ValueId> = []
): BlockValueAnalysis {
  return new BlockValueUsage(block, exportedOutputs);
}

class BlockValueUsage implements BlockValueAnalysis {
  readonly #values: ValueTable;
  readonly #edges = new Map<RegionId, EdgeRegion>();
  readonly #useCounts = new Map<ValueId, number>();
  readonly #firstUses = new Map<ValueId, number>();
  readonly #lastUses = new Map<ValueId, number>();
  // Producers have no effects of their own, so a dead output kills the whole
  // action: its operands are charged on demand, never up front.
  readonly #producers = new Map<ValueId, Readonly<{ action: Action; actionIndex: number }>>();
  readonly #pinned = new Set<ValueId>();

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#values = block.values;

    const entry = block.regions.find((region) => region.id === block.entry);

    assert(entry !== undefined && entry.kind === "entry", "IR block entry region is missing");

    for (const region of block.regions) {
      if (region.kind === "edge") {
        this.#edges.set(region.id, region);
      }
    }

    this.#chargeActionUses(entry);
    this.#chargeExportedUses(entry, exportedOutputs);
    this.#chargeValueGraph();
    this.#pinReadsCrossingStores(entry);
    this.#pinReadsCrossingEdgeFlushes(entry);
  }

  useCount(id: ValueId): number {
    this.#values.node(id);
    return this.#useCounts.get(id) ?? 0;
  }

  lastUse(id: ValueId): number | undefined {
    this.#values.node(id);
    return this.#lastUses.get(id);
  }

  isPinned(id: ValueId): boolean {
    this.#values.node(id);
    return this.#pinned.has(id);
  }

  #addUse(id: ValueId, actionIndex: number): void {
    this.#useCounts.set(id, (this.#useCounts.get(id) ?? 0) + 1);
    this.#firstUses.set(id, Math.min(this.#firstUses.get(id) ?? actionIndex, actionIndex));
    this.#lastUses.set(id, Math.max(this.#lastUses.get(id) ?? actionIndex, actionIndex));
  }

  #chargeActionUses(entry: EntryRegion): void {
    entry.actions.forEach((action, actionIndex) => {
      const output = actionOutput(action);

      if (output !== undefined) {
        // The descending walk settles an output before its operands.
        for (const operand of actionOperands(action)) {
          assert(operand < output, `producer operand ${operand} created after its output ${output}`);
        }

        this.#producers.set(output, { action, actionIndex });
        return;
      }

      for (const operand of actionOperands(action)) {
        this.#addUse(operand, actionIndex);
      }

      switch (action.kind) {
        case "guardMemory":
          this.#chargeEdgeUses(action.faultEdge, actionIndex);
          break;
        case "branch":
          this.#chargeEdgeUses(action.taken, actionIndex);
          this.#chargeEdgeUses(action.notTaken, actionIndex);
          break;
        default:
          break;
      }
    });
  }

  // Exported outputs materialize after the action body and before the
  // embedding handles its dispatch or fallthrough.
  #chargeExportedUses(entry: EntryRegion, exported: Iterable<ValueId>): void {
    const lastActionIndex = entry.actions.length - 1;
    const lastAction = entry.actions[lastActionIndex];
    const actionIndex =
      lastAction !== undefined && isTerminatorAction(lastAction) ? lastActionIndex : entry.actions.length;

    for (const id of exported) {
      this.#values.node(id);
      this.#addUse(id, actionIndex);
    }
  }

  // An edge branches off at its guard or branch, so its uses land there.
  #chargeEdgeUses(edgeId: RegionId, actionIndex: number): void {
    const edge = this.#edges.get(edgeId);

    assert(edge !== undefined, `entry action targets unknown edge region ${edgeId}`);

    for (const value of edgeValues(edge)) {
      this.#addUse(value, actionIndex);
    }
  }

  // Children always have lower ids than their parents, and a producer's
  // operands precede its output, so a descending walk sees every id's uses
  // settled before charging what it consumes: a used compound consumes its
  // children at its first use (it computes once there, however often it is
  // replayed), a used output consumes its producer's operands at the
  // producing action.
  #chargeValueGraph(): void {
    for (let id = this.#values.size() - 1; id >= 0; id -= 1) {
      if ((this.#useCounts.get(id) ?? 0) === 0) {
        continue;
      }

      const producer = this.#producers.get(id);

      if (producer !== undefined) {
        // An output is a leaf in the value graph.
        for (const operand of actionOperands(producer.action)) {
          this.#addUse(operand, producer.actionIndex);
        }

        continue;
      }

      const computedAt = this.#firstUses.get(id)!;

      for (const child of valueChildren(this.#values.node(id))) {
        this.#addUse(child, computedAt);
      }
    }
  }

  // The one ordering rule: a readState whose value is consumed past a
  // may-aliasing store pins at its action point. Guest memory never aliases
  // state, so slot may-alias is the whole aliasing story.
  #pinReadsCrossingStores(entry: EntryRegion): void {
    entry.actions.forEach((action, actionIndex) => {
      if (action.kind !== "readState") {
        return;
      }

      const lastUse = this.#lastUses.get(action.output);

      if (lastUse === undefined) {
        return;
      }

      // An operand of the store action itself is pushed before the store
      // executes, so a use at the store's own index stays safe.
      for (let index = actionIndex + 1; index < lastUse; index += 1) {
        const later = entry.actions[index]!;

        if (actionMayWriteStateSlot(later, action.slot)) {
          this.#pinned.add(action.output);
          break;
        }
      }
    });
  }

  // The same rule from the edge body's viewpoint: a read of a channel the
  // edge itself flushes would reload the edge's restore, so it pins —
  // keeping the flushes and exit free to emit in any order.
  #pinReadsCrossingEdgeFlushes(entry: EntryRegion): void {
    const readsByOutput = new Map<ValueId, ReadStateAction>();

    for (const action of entry.actions) {
      if (action.kind === "readState") {
        readsByOutput.set(action.output, action);
      }
    }

    for (const edge of this.#edges.values()) {
      for (const value of edgeValues(edge)) {
        const read = readsByOutput.get(value);

        if (read !== undefined && edge.flushes.some((flush) => actionMayWriteStateSlot(flush, read.slot))) {
          this.#pinned.add(read.output);
        }
      }
    }
  }
}

// Everything an edge consumes: its flush values and the exit payload.
export function edgeValues(edge: EdgeRegion): readonly ValueId[] {
  const values = edge.flushes.flatMap(actionOperands);

  switch (edge.terminator.kind) {
    case "exit":
      if (edge.terminator.payload !== undefined) {
        values.push(edge.terminator.payload);
      }

      break;
    case "dispatch":
      break;
  }

  return values;
}

function actionOperands(action: Action): readonly ValueId[] {
  switch (action.kind) {
    case "readState":
      return slotOperands(action.slot);
    case "readMemory":
      return [action.address];
    case "writeState":
      return [...slotOperands(action.slot), action.value];
    case "writeMemory":
      return [action.address, action.value];
    case "guardMemory":
      return [action.address];
    case "branch":
      return [action.condition];
    case "exit":
      return action.payload === undefined ? [] : [action.payload];
    case "dispatch":
      return [];
  }
}

// One index use per address push, matching the state layer's lowering: byte
// access pushes the index twice (word term and high-byte term).
function slotOperands(slot: StateSlot): readonly ValueId[] {
  switch (slot.kind) {
    case "gprDynamic":
      switch (slot.byteLength) {
        case 1:
          return [slot.index, slot.index];
        case 2:
        case 4:
          return [slot.index];
      }
    case "gpr":
    case "flag":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return [];
  }
}

function actionOutput(action: Action): ValueId | undefined {
  switch (action.kind) {
    case "readState":
    case "readMemory":
      return action.output;
    case "writeState":
    case "writeMemory":
    case "guardMemory":
    case "branch":
    case "exit":
    case "dispatch":
      return undefined;
  }
}

function valueChildren(node: ValueNode): readonly ValueId[] {
  switch (node.kind) {
    case "const":
    case "actionOutput":
    case "external":
    case "helperCall":
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
