import { assert } from "#common/assert.js";
import { effectsOf, mayAlias } from "#ir/aliasing.js";
import { bodyFinal, type Action, type OpAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess, type OpAccess, type StorageAccess } from "#ir/ops.js";
import { actionOutput, finishOperands, nestedBodies } from "#ir/traverse.js";
import type { ValueId, ValueNode, ValueTable } from "#ir/values.js";

// The placement analysis: decides up front, from the action lists and the
// value graph, where every value materializes — use counts for the tee
// bookkeeping, per-output emission schedules for scheduled producers. No
// encoder imports — the value stack consumes this, the analysis never
// emits.

export type OutputPlacement =
  | Readonly<{ kind: "deferToUse"; emissions: readonly ScheduledEmission[] }>
  | Readonly<{ kind: "captureAtProducer" }>;

// One scheduled emission of a deferred producer, serving `uses` counted
// uses from one tee/local. "use": the op executes at its first use in
// `body`. "bodyEntry": the op executes when the enclosing scope captures
// `body`, on the owning scope's flow before the control action.
export type ScheduledEmission = Readonly<{
  anchor: "use" | "bodyEntry";
  body: Body;
  uses: number;
}>;

// Registration default: no demand, no scheduled emissions.
const deferToUsePlacement: OutputPlacement = { kind: "deferToUse", emissions: [] };
const captureAtProducerPlacement: OutputPlacement = { kind: "captureAtProducer" };

export type BlockPlacement = Readonly<{
  // Emission uses: demanded action operands plus the child inputs of every
  // reachable compound, counted once per parent per body scope.
  useCount(id: ValueId): number;
  // Scheduled producer outputs either materialize at their action point or
  // defer to their use sites; a deferred placement carries the counted
  // uses each scheduled emission covers, in emission order.
  outputPlacement(output: ValueId): OutputPlacement;
}>;

export function analyzePlacement(
  block: IrBlock,
  exportedOutputs: Iterable<ValueId> = []
): BlockPlacement {
  return new PlacementAnalysis(block, exportedOutputs);
}

type DemandSite = Readonly<{ body: Body; actionIndex: number }>;

// One consumption of a value. `site` is where the value enters its scope's
// index space — nested-body uses land at the owning action, as the registry
// and the walks require; `use` is the action that actually consumes it, in
// its own body's index space, which is what placement legality needs.
type DemandEdge = Readonly<{ value: ValueId; site: DemandSite; use: DemandSite }>;

type Producer = Readonly<{
  action: OpAction;
  access: OpAccess;
  output: ValueId;
  site: DemandSite;
  operandDemands: readonly DemandEdge[];
}>;

// Scheduling workspace for one emission: the public anchor plus where it
// executes (`position`, carried on its input edges for nested placement
// decisions) and where its demand enters the producer's own body
// (`homeEntry` — the emission's deferral-window end and the point its
// inputs materialize on the producer's flow).
type PlannedEmission = Readonly<{
  anchor: "use" | "bodyEntry";
  body: Body;
  uses: number;
  homeEntry: number;
  position: DemandSite;
}>;

class PlacementAnalysis implements BlockPlacement {
  readonly #values: ValueTable;
  readonly #demandCounts = new Map<ValueId, number>();
  // First demand index per body scope, in that scope's index space:
  // compound children charge there.
  readonly #firstDemands = new Map<ValueId, Map<Body, number>>();
  readonly #producers = new Map<ValueId, Producer>();
  readonly #outputUses = new Map<ValueId, DemandEdge[]>();
  readonly #outputPlacements = new Map<ValueId, OutputPlacement>();
  readonly #bodyOwners = new Map<Body, DemandSite>();

  constructor(block: IrBlock, exportedOutputs: Iterable<ValueId>) {
    this.#values = block.values;

    this.#recordBodyOwners(block.body);
    this.#recordActionDemandRoots(block.body);
    this.#recordExportedDemandRoots(block.body, exportedOutputs);
    this.#propagateDemandAndPlace();
  }

  useCount(id: ValueId): number {
    this.#values.node(id);
    return this.#demandCounts.get(id) ?? 0;
  }

  outputPlacement(output: ValueId): OutputPlacement {
    this.#values.node(output);

    const placement = this.#outputPlacements.get(output);

    assert(placement !== undefined, `value ${output} is not a scheduled producer output`);
    return placement;
  }

  #recordBodyOwners(body: Body): void {
    body.actions.forEach((action, actionIndex) => {
      for (const nested of nestedBodies(action)) {
        this.#bodyOwners.set(nested, { body, actionIndex });
        this.#recordBodyOwners(nested);
      }
    });
  }

  #addDemand(edge: DemandEdge): void {
    this.#values.node(edge.value);
    this.#demandCounts.set(edge.value, (this.#demandCounts.get(edge.value) ?? 0) + 1);

    if (this.#producers.has(edge.value)) {
      let edges = this.#outputUses.get(edge.value);

      if (edges === undefined) {
        edges = [];
        this.#outputUses.set(edge.value, edges);
      }

      edges.push(edge);
    }

    let byBody = this.#firstDemands.get(edge.value);

    if (byBody === undefined) {
      byBody = new Map();
      this.#firstDemands.set(edge.value, byBody);
    }

    const first = byBody.get(edge.site.body);

    byBody.set(
      edge.site.body,
      first === undefined ? edge.site.actionIndex : Math.min(first, edge.site.actionIndex)
    );
  }

  #recordActionDemandRoots(body: Body, ownerSite?: DemandSite): void {
    const produced = new Set<ValueId>();

    body.actions.forEach((action, localActionIndex) => {
      const actionSite = { body, actionIndex: localActionIndex };
      const demandEdge = (value: ValueId): DemandEdge => ({
        value,
        site: produced.has(value) ? actionSite : ownerSite ?? actionSite,
        use: actionSite
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
              site: actionSite,
              operandDemands
            });
            this.#outputPlacements.set(output, deferToUsePlacement);
            produced.add(output);
          }

          if (access.writes.length > 0) {
            for (const operand of operandDemands) {
              this.#addDemand(operand);
            }
          }

          return;
        }
        case "if":
          this.#addDemand(demandEdge(action.condition));

          for (const nested of nestedBodies(action)) {
            this.#recordActionDemandRoots(nested, actionSite);
          }
          return;
        case "finish":
          for (const operand of finishOperands(action.finish)) {
            this.#addDemand(demandEdge(operand));
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
      this.#addDemand({ value: id, site, use: site });
    }
  }

  // Children always have lower ids than their parents, and a producer's
  // operands precede its output, so a descending walk sees every id's uses
  // settled before recording what it consumes. Placement rides the same
  // walk: an output's demand is complete when the walk reaches it, so its
  // producer's placement — and with it where the producer's operands are
  // charged — is decided right there. A demanded compound demands its
  // children at its first use in each body scope; a captured producer
  // demands its operands at the producing action; a deferred producer
  // demands them once, at the point it will execute.
  #propagateDemandAndPlace(): void {
    for (let id = this.#values.size() - 1; id >= 0; id -= 1) {
      if ((this.#demandCounts.get(id) ?? 0) === 0) {
        continue;
      }

      const producer = this.#producers.get(id);

      if (producer !== undefined) {
        this.#placeProducer(producer);
        continue;
      }

      const demands = this.#firstDemands.get(id);

      assert(demands !== undefined, `demanded value ${id} has no demand sites`);
      for (const [body, firstActionIndex] of demands) {
        const computedAt = { body, actionIndex: firstActionIndex };

        for (const child of valueChildren(this.#values.node(id))) {
          this.#addDemand({ value: child, site: computedAt, use: computedAt });
        }
      }
    }
  }

  // The placement rule, computed from the op's access signature: a pure
  // producer whose reads survive untouched from its action point to each
  // of its scheduled emissions defers; everything else captures at its
  // producer.
  #placeProducer(producer: Producer): void {
    if (producer.access.writes.length > 0) {
      // Mutating ops execute at their action point; their operands were
      // already charged as demand roots when the action was recorded.
      this.#outputPlacements.set(producer.output, captureAtProducerPlacement);
      return;
    }

    const edges = this.#outputUses.get(producer.output);

    assert(edges !== undefined, `demanded output ${producer.output} has no recorded uses`);

    const planned: PlannedEmission[] = [];

    this.#scheduleScope(producer.site.body, edges, undefined, planned);

    if (
      // Home entries never decrease in emission order, so the last
      // emission's entry bounds every emission's deferral window.
      this.#writesCrossDeferralWindow(producer, planned[planned.length - 1]!.homeEntry) ||
      this.#consumingBodiesWriteReads(producer)
    ) {
      this.#outputPlacements.set(producer.output, captureAtProducerPlacement);
      for (const operand of producer.operandDemands) {
        this.#addDemand(operand);
      }

      return;
    }

    this.#outputPlacements.set(producer.output, {
      kind: "deferToUse",
      emissions: planned.map(({ anchor, body, uses }) => ({ anchor, body, uses }))
    });

    // Each scheduled emission charges the op's inputs once. A sunk
    // emission's inputs materialize where the capture walk runs — the
    // subtree's entry on the producer's flow — while its execution point
    // carries the edges for nested placement decisions.
    for (const emission of planned) {
      const site = { body: producer.site.body, actionIndex: emission.homeEntry };

      for (const value of producer.access.valueInputs) {
        this.#addDemand({ value, site, use: emission.position });
      }
    }
  }

  // One emission per scope that itself demands the value, at the latest
  // scope point dominating all of the scope's demand: the first direct
  // use when no demanding subtree hangs earlier, else the entry of the
  // earliest demanding subtree. A scope with subtree demand only hosts no
  // emission — the op sinks into each demanding subtree, recursively, so
  // demand confined to a subtree never costs the enclosing scope.
  #scheduleScope(
    scope: Body,
    edges: readonly DemandEdge[],
    homeEntry: number | undefined,
    out: PlannedEmission[]
  ): void {
    let firstDirect: number | undefined;
    const subtrees = new Map<Body, { entryIndex: number; edges: DemandEdge[] }>();

    for (const edge of edges) {
      if (edge.use.body === scope) {
        firstDirect =
          firstDirect === undefined
            ? edge.use.actionIndex
            : Math.min(firstDirect, edge.use.actionIndex);
        continue;
      }

      const entry = this.#entryToward(scope, edge.use.body);
      const subtree = subtrees.get(entry.body);

      if (subtree === undefined) {
        subtrees.set(entry.body, { entryIndex: entry.actionIndex, edges: [edge] });
      } else {
        subtree.edges.push(edge);
      }
    }

    const ordered = [...subtrees].sort((a, b) => a[1].entryIndex - b[1].entryIndex);

    if (firstDirect === undefined) {
      for (const [body, subtree] of ordered) {
        this.#scheduleScope(body, subtree.edges, homeEntry ?? subtree.entryIndex, out);
      }

      return;
    }

    const earliest = ordered[0];

    if (earliest === undefined || firstDirect <= earliest[1].entryIndex) {
      // A demanding subtree hanging at the first use's own index is the
      // consuming if's arm: the condition materializes the value before
      // the arms run.
      out.push({
        anchor: "use",
        body: scope,
        uses: edges.length,
        homeEntry: homeEntry ?? firstDirect,
        position: { body: scope, actionIndex: firstDirect }
      });

      return;
    }

    out.push({
      anchor: "bodyEntry",
      body: earliest[0],
      uses: edges.length,
      homeEntry: homeEntry ?? earliest[1].entryIndex,
      position: { body: scope, actionIndex: earliest[1].entryIndex }
    });
  }

  // The nested body directly under `ancestor` on the way to `body`, with
  // the index of the action that owns it.
  #entryToward(ancestor: Body, body: Body): DemandSite {
    for (let current = body; ; ) {
      const owner = this.#bodyOwners.get(current);

      assert(owner !== undefined, "demand edge body is not reachable from its producer's body");
      if (owner.body === ancestor) {
        return { body: current, actionIndex: owner.actionIndex };
      }

      current = owner.body;
    }
  }

  // No action between the producer and any emission's entry into the
  // producer's body may write anything the op reads: every emission must
  // observe the action point's state. An operand of the final entry action
  // itself is pushed before that action executes, so the walk stops short
  // of it. Guest memory never aliases state, but the query still goes
  // through opAccess-derived effects.
  #writesCrossDeferralWindow(producer: Producer, entryIndex: number): boolean {
    const actions = producer.site.body.actions;

    for (let index = producer.site.actionIndex + 1; index < entryIndex; index += 1) {
      if (actionMayWriteAny(actions[index]!, producer.access.reads)) {
        return true;
      }
    }

    return false;
  }

  // The same rule from the consuming bodies' viewpoint: executing the op in
  // or past a body that writes what it reads would observe the body's own
  // stores, so the producer captures, keeping bodies free to emit their
  // writes and exits in any order. Charging deferred inputs at their
  // consumer's emission point lands their edges in the consuming body, so
  // this walk sees hazards through a deferred op's input closure too.
  #consumingBodiesWriteReads(producer: Producer): boolean {
    const edges = this.#outputUses.get(producer.output) ?? [];
    const seen = new Set<Body>();

    for (const edge of edges) {
      for (let body = edge.use.body; body !== producer.site.body; ) {
        if (!seen.has(body)) {
          seen.add(body);
          if (bodyMayWriteAny(body, producer.access.reads)) {
            return true;
          }
        }

        const owner = this.#bodyOwners.get(body);

        assert(owner !== undefined, "demand edge body is not reachable from its producer's body");
        body = owner.body;
      }
    }

    return false;
  }
}

function actionMayWriteAny(action: Action, reads: readonly StorageAccess[]): boolean {
  const writes = effectsOf(action).writes;

  return reads.some((read) => writes.some((write) => mayAlias(read, write)));
}

function bodyMayWriteAny(body: Body, reads: readonly StorageAccess[]): boolean {
  return body.actions.some((action) => actionMayWriteAny(action, reads));
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
