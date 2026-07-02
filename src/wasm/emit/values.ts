import { assert } from "#common/assert.js";
import { actionMayWriteStateSlot, bodyMayWriteStateSlot } from "#ir/aliasing.js";
import { bodyFinal, type Action, type Finish } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess } from "#ir/ops.js";
import type { StateSlot } from "#ir/slots.js";
import { nestedBodies, walkBodyActions } from "#ir/traverse.js";
import type { ValueId, ValueNode, ValueTable } from "#ir/values.js";

// Pure value analysis for the action emitter: everything is decided up front
// from the action lists and the value graph. No encoder imports — the value
// stack consumes this, the analysis never emits.

export type BlockValueAnalysis = Readonly<{
  // Emission uses: action operands plus the child inputs of every
  // reachable compound, counted once per parent.
  useCount(id: ValueId): number;
  // Entry action index of the last point the value is pushed onto the
  // stack: direct operand uses, plus the first use of each reachable
  // parent; nested-body uses count at their owning guard/if index.
  lastUse(id: ValueId): number | undefined;
  // state.read outputs that must be captured to a local at their action
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
  readonly #useCounts = new Map<ValueId, number>();
  readonly #firstUses = new Map<ValueId, number>();
  readonly #lastUses = new Map<ValueId, number>();
  // Producers have no effects of their own, so a dead output kills the whole
  // action: its operands are charged on demand, never up front.
  readonly #producers = new Map<ValueId, Readonly<{ action: Action; actionIndex: number }>>();
  readonly #pinned = new Set<ValueId>();

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#values = block.values;

    this.#chargeActionUses(block.body);
    this.#chargeExportedUses(block.body, exportedOutputs);
    this.#chargeValueGraph();
    this.#pinReadsCrossingStores(block.body);
    this.#pinReadsCrossingNestedBodyWrites(block.body);
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

  #chargeActionUses(body: Body, ownerActionIndex?: number): void {
    body.actions.forEach((action, localActionIndex) => {
      const actionIndex = ownerActionIndex ?? localActionIndex;
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

      for (const nested of nestedBodies(action)) {
        this.#chargeActionUses(nested, actionIndex);
      }
    });
  }

  // Exported outputs materialize after the action body and before the
  // embedding handles its dispatch or fallthrough.
  #chargeExportedUses(body: Body, exported: Iterable<ValueId>): void {
    const lastActionIndex = body.actions.length - 1;
    const actionIndex = bodyFinal(body) === undefined ? body.actions.length : lastActionIndex;

    for (const id of exported) {
      this.#values.node(id);
      this.#addUse(id, actionIndex);
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

  // The one ordering rule: a state.read whose value is consumed past a
  // may-aliasing store pins at its action point. Guest memory never aliases
  // state, so slot may-alias is the whole aliasing story.
  //
  // Root body only: nested bodies hold no state.reads, and their uses are
  // charged at the owning action's index, so a per-body scan would compare
  // mismatched index spaces.
  #pinReadsCrossingStores(body: Body): void {
    body.actions.forEach((action, actionIndex) => {
      const read = stateRead(action);

      if (read === undefined) {
        return;
      }

      const lastUse = this.#lastUses.get(read.output);

      if (lastUse === undefined) {
        return;
      }

      // An operand of the store action itself is pushed before the store
      // executes, so a use at the store's own index stays safe.
      for (let index = actionIndex + 1; index < lastUse; index += 1) {
        const later = body.actions[index]!;

        if (actionMayWriteStateSlot(later, read.slot)) {
          this.#pinned.add(read.output);
          break;
        }
      }
    });
  }

  // The same rule from the nested body's viewpoint: a read of a channel the
  // body itself writes would reload the nested body's restore, so it pins —
  // keeping the body free to emit its writes and exit in any order.
  #pinReadsCrossingNestedBodyWrites(body: Body): void {
    const readsByOutput = new Map<ValueId, StateRead>();

    walkBodyActions(body, (action) => {
      const read = stateRead(action);

      if (read !== undefined) {
        readsByOutput.set(read.output, read);
      }
    });

    walkBodyActions(body, (action) => {
      for (const nested of nestedBodies(action)) {
        for (const value of bodyInputValues(nested)) {
          const read = readsByOutput.get(value);

          if (read !== undefined && bodyMayWriteStateSlot(nested, read.slot)) {
            this.#pinned.add(read.output);
          }
        }
      }
    });
  }
}

// Everything a nested body consumes from its parent context. Values produced
// inside the body are deliberately excluded; their consumers run after the
// producer action has executed.
export function bodyInputValues(body: Body): readonly ValueId[] {
  const produced = new Set<ValueId>();
  const values: ValueId[] = [];

  for (const action of body.actions) {
    for (const operand of actionOperands(action)) {
      if (!produced.has(operand)) {
        values.push(operand);
      }
    }

    for (const nested of nestedBodies(action)) {
      for (const operand of bodyInputValues(nested)) {
        if (!produced.has(operand)) {
          values.push(operand);
        }
      }
    }

    const output = actionOutput(action);

    if (output !== undefined) {
      produced.add(output);
    }
  }

  return values;
}

function actionOperands(action: Action): readonly ValueId[] {
  switch (action.kind) {
    case "op":
      return opAccess(action.op).valueInputs;
    case "guardMemory":
      return [action.address];
    case "if":
      return [action.condition];
    case "finish":
      return finishOperands(action.finish);
  }
}

function finishOperands(finish: Finish): readonly ValueId[] {
  switch (finish.kind) {
    case "exit":
      return finish.payload === undefined ? [] : [finish.payload];
    case "dispatch":
      return [];
  }
}

function actionOutput(action: Action): ValueId | undefined {
  switch (action.kind) {
    case "op": {
      if (opAccess(action.op).valueOutput === undefined) {
        return undefined;
      }

      assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
      return action.output;
    }
    case "guardMemory":
    case "if":
    case "finish":
      return undefined;
  }
}

type StateRead = Readonly<{ output: ValueId; slot: StateSlot }>;

function stateRead(action: Action): StateRead | undefined {
  if (action.kind !== "op" || action.op.kind !== "state.read") {
    return undefined;
  }

  const output = actionOutput(action);

  assert(output !== undefined, "state.read op action is missing its output");

  return { output, slot: action.op.slot };
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
    case "extend":
    case "truncate":
      return [node.value];
    case "select":
      return [node.condition, node.whenTrue, node.whenFalse];
  }
}
