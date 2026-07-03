import { assert } from "#common/assert.js";
import { effectsOf, mayAlias } from "#ir/aliasing.js";
import { bodyFinal, type Action, type Finish, type IrExit, type OpAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess, type OpAccess, type StorageAccess } from "#ir/ops.js";
import { isDynamicSlot } from "#ir/slots.js";
import { nestedBodies, walkBodyActions } from "#ir/traverse.js";
import type { ValueId, ValueNode, ValueTable } from "#ir/values.js";

// Pure value analysis for the action emitter: everything is decided up front
// from the action lists and the value graph. No encoder imports — the value
// stack consumes this, the analysis never emits.

export type OutputPlacement =
  | Readonly<{ kind: "deferToUse" }>
  | Readonly<{ kind: "captureAtProducer" }>;

const deferToUsePlacement: OutputPlacement = { kind: "deferToUse" };
const captureAtProducerPlacement: OutputPlacement = { kind: "captureAtProducer" };

export type BlockValueAnalysis = Readonly<{
  // Emission uses: demanded action operands plus the child inputs of every
  // reachable compound, counted once per parent per body scope.
  useCount(id: ValueId): number;
  // Entry action index of the last point the value is pushed onto the
  // stack: direct operand uses, plus the first use of each reachable
  // parent; nested-body uses count at their owning if index.
  lastUse(id: ValueId): number | undefined;
  // Scheduled producer outputs either materialize at their action point or
  // defer to their use sites.
  outputPlacement(output: ValueId): OutputPlacement;
}>;

export function analyzeBlockValues(
  block: IrBlock,
  exportedOutputs: Iterable<ValueId> = []
): BlockValueAnalysis {
  return new BlockValueDemand(block, exportedOutputs);
}

type DemandSite = Readonly<{ body: Body; actionIndex: number }>;

type BodyDemand = {
  firstActionIndex: number;
  lastActionIndex: number;
};

type DemandEdge = Readonly<{ value: ValueId; site: DemandSite }>;

type Producer = Readonly<{
  action: OpAction;
  access: OpAccess;
  output: ValueId;
  operandDemands: readonly DemandEdge[];
}>;

type StateRead = Readonly<{ output: ValueId; access: StorageAccess }>;

class BlockValueDemand implements BlockValueAnalysis {
  readonly #values: ValueTable;
  readonly #demandCounts = new Map<ValueId, number>();
  readonly #demandsByValue = new Map<ValueId, Map<Body, BodyDemand>>();
  readonly #producers = new Map<ValueId, Producer>();
  readonly #outputPlacements = new Map<ValueId, OutputPlacement>();

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#values = block.values;

    this.#recordActionDemandRoots(block.body);
    this.#recordExportedDemandRoots(block.body, exportedOutputs);
    this.#propagateDemand();
    this.#captureReadsCrossingStores(block.body);
    this.#captureReadsCrossingNestedBodyWrites(block.body);
  }

  useCount(id: ValueId): number {
    this.#values.node(id);
    return this.#demandCounts.get(id) ?? 0;
  }

  lastUse(id: ValueId): number | undefined {
    this.#values.node(id);
    const demands = this.#demandsByValue.get(id);

    if (demands === undefined) {
      return undefined;
    }

    // Maxing across bodies assumes every demand site lives in the root
    // body's index space, which holds while nested bodies contain no
    // producers: parent-context demand lands at the owning action's root
    // site. Arm-local producers would record sites in their own body's
    // space, making this max meaningless across bodies.
    let last: number | undefined;

    for (const demand of demands.values()) {
      last = Math.max(last ?? demand.lastActionIndex, demand.lastActionIndex);
    }

    return last;
  }

  outputPlacement(output: ValueId): OutputPlacement {
    this.#values.node(output);

    const placement = this.#outputPlacements.get(output);

    assert(placement !== undefined, `value ${output} is not a scheduled producer output`);
    return placement;
  }

  #addDemand(id: ValueId, site: DemandSite): void {
    this.#values.node(id);
    this.#demandCounts.set(id, (this.#demandCounts.get(id) ?? 0) + 1);

    let byBody = this.#demandsByValue.get(id);

    if (byBody === undefined) {
      byBody = new Map();
      this.#demandsByValue.set(id, byBody);
    }

    const demand = byBody.get(site.body);

    if (demand === undefined) {
      byBody.set(site.body, {
        firstActionIndex: site.actionIndex,
        lastActionIndex: site.actionIndex
      });
      return;
    }

    demand.firstActionIndex = Math.min(demand.firstActionIndex, site.actionIndex);
    demand.lastActionIndex = Math.max(demand.lastActionIndex, site.actionIndex);
  }

  #recordActionDemandRoots(body: Body, ownerSite?: DemandSite): void {
    const produced = new Set<ValueId>();

    body.actions.forEach((action, localActionIndex) => {
      const actionSite = { body, actionIndex: localActionIndex };
      const demandEdge = (value: ValueId): DemandEdge => ({
        value,
        site: produced.has(value) ? actionSite : ownerSite ?? actionSite
      });

      switch (action.kind) {
        case "op": {
          const access = opAccess(action.op);
          const output = actionOutput(action, access);
          const operandDemands = access.valueInputs.map(demandEdge);

          if (output !== undefined) {
            // The descending walk settles an output before its operands.
            for (const operand of access.valueInputs) {
              assert(operand < output, `producer operand ${operand} created after its output ${output}`);
            }

            assert(!this.#producers.has(output), `value ${output} already has a scheduled producer`);
            this.#producers.set(output, {
              action,
              access,
              output,
              operandDemands
            });
            this.#outputPlacements.set(output, initialOutputPlacement(action));
            produced.add(output);
          }

          if (access.writes.length > 0) {
            for (const operand of operandDemands) {
              this.#addDemand(operand.value, operand.site);
            }
          }

          return;
        }
        case "if":
          {
            const condition = demandEdge(action.condition);

            this.#addDemand(condition.value, condition.site);
          }

          for (const nested of nestedBodies(action)) {
            this.#recordActionDemandRoots(nested, actionSite);
          }
          return;
        case "finish":
          for (const operand of finishOperands(action.finish)) {
            const demand = demandEdge(operand);

            this.#addDemand(demand.value, demand.site);
          }
          return;
      }
    });
  }

  // Exported outputs materialize after the action body and before the
  // embedding handles its dispatch or fallthrough.
  #recordExportedDemandRoots(body: Body, exported: Iterable<ValueId>): void {
    const lastActionIndex = body.actions.length - 1;
    const actionIndex = bodyFinal(body) === undefined ? body.actions.length : lastActionIndex;
    const site = { body, actionIndex };

    for (const id of exported) {
      this.#addDemand(id, site);
    }
  }

  // Children always have lower ids than their parents, and a producer's
  // operands precede its output, so a descending walk sees every id's uses
  // settled before recording what it consumes: a demanded compound demands
  // its children at its first use in each body scope, and a demanded output
  // demands its producer's operands at the producing action.
  #propagateDemand(): void {
    for (let id = this.#values.size() - 1; id >= 0; id -= 1) {
      if ((this.#demandCounts.get(id) ?? 0) === 0) {
        continue;
      }

      const producer = this.#producers.get(id);

      if (producer !== undefined) {
        for (const operand of producer.operandDemands) {
          this.#addDemand(operand.value, operand.site);
        }

        continue;
      }

      const demands = this.#demandsByValue.get(id);

      assert(demands !== undefined, `demanded value ${id} has no demand sites`);
      for (const [body, demand] of demands) {
        const computedAt = { body, actionIndex: demand.firstActionIndex };

        for (const child of valueChildren(this.#values.node(id))) {
          this.#addDemand(child, computedAt);
        }
      }
    }
  }

  // The one ordering rule: a state.read whose value is consumed past a
  // may-aliasing store captures at its action point. Guest memory never
  // aliases state, but the query still goes through opAccess-derived effects.
  #captureReadsCrossingStores(body: Body): void {
    body.actions.forEach((action, actionIndex) => {
      const read = stateReadProducer(this.#producerForActionOutput(action));

      if (read === undefined) {
        return;
      }

      const lastDemand = this.#demandsByValue.get(read.output)?.get(body)?.lastActionIndex;

      if (lastDemand === undefined) {
        return;
      }

      // An operand of the store action itself is pushed before the store
      // executes, so a use at the store's own index stays safe.
      for (let index = actionIndex + 1; index < lastDemand; index += 1) {
        const later = body.actions[index]!;

        if (actionMayWrite(later, read.access)) {
          this.#captureOutput(read.output);
          break;
        }
      }
    });

    for (const action of body.actions) {
      for (const nested of nestedBodies(action)) {
        this.#captureReadsCrossingStores(nested);
      }
    }
  }

  // The same rule from the nested body's viewpoint: a read of a channel the
  // body itself writes would reload the nested body's restore, so it captures,
  // keeping the body free to emit its writes and exit in any order.
  #captureReadsCrossingNestedBodyWrites(body: Body): void {
    const readsByOutput = new Map<ValueId, StateRead>();

    walkBodyActions(body, (action) => {
      const read = stateReadProducer(this.#producerForActionOutput(action));

      if (read !== undefined) {
        readsByOutput.set(read.output, read);
      }
    });

    walkBodyActions(body, (action) => {
      for (const nested of nestedBodies(action)) {
        for (const value of bodyInputValues(nested)) {
          const read = readsByOutput.get(value);

          if (read !== undefined && bodyMayWrite(nested, read.access)) {
            this.#captureOutput(read.output);
          }
        }
      }
    });
  }

  #producerForActionOutput(action: Action): Producer | undefined {
    const output = actionOutput(action);

    return output === undefined ? undefined : this.#producers.get(output);
  }

  #captureOutput(output: ValueId): void {
    assert(
      this.#outputPlacements.has(output),
      `value ${output} is not a scheduled producer output`
    );
    this.#outputPlacements.set(output, captureAtProducerPlacement);
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
    case "if":
      return [action.condition];
    case "finish":
      return finishOperands(action.finish);
  }
}

function finishOperands(finish: Finish): readonly ValueId[] {
  switch (finish.kind) {
    case "exit":
      return exitOperands(finish.exit);
    case "dispatch":
      return [];
  }
}

function exitOperands(exit: IrExit): readonly ValueId[] {
  switch (exit.class) {
    case "cpuException": {
      const exception = exit.exception;

      switch (exception.kind) {
        case "DE":
          return [];
        case "PF":
          return [exception.linearAddress];
      }
    }
    case "host":
      return exit.payload === undefined ? [] : [exit.payload];
  }
}

function actionOutput(action: Action, access?: OpAccess): ValueId | undefined {
  switch (action.kind) {
    case "op": {
      if ((access ?? opAccess(action.op)).valueOutput === undefined) {
        return undefined;
      }

      assert(action.output !== undefined, `${action.op.kind} op action is missing its output`);
      return action.output;
    }
    case "if":
    case "finish":
      return undefined;
  }
}

function initialOutputPlacement(action: OpAction): OutputPlacement {
  if (action.op.kind === "state.read" && !isDynamicSlot(action.op.slot)) {
    return deferToUsePlacement;
  }

  return captureAtProducerPlacement;
}

function stateReadProducer(producer: Producer | undefined): StateRead | undefined {
  if (
    producer === undefined ||
    producer.action.op.kind !== "state.read" ||
    isDynamicSlot(producer.action.op.slot)
  ) {
    return undefined;
  }

  const read = producer.access.reads.find((access) => access.space === "state");

  assert(read !== undefined, "state.read producer has no state read access");
  return { output: producer.output, access: read };
}

function actionMayWrite(action: Action, read: StorageAccess): boolean {
  return effectsOf(action).writes.some((write) => mayAlias(read, write));
}

function bodyMayWrite(body: Body, read: StorageAccess): boolean {
  return body.actions.some((action) => actionMayWrite(action, read));
}

function valueChildren(node: ValueNode): readonly ValueId[] {
  switch (node.kind) {
    case "const":
    case "actionOutput":
    case "external":
    case "unreachable":
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
