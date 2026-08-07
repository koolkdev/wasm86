import { buildDefinition } from "#build";
import { assert } from "#common/assert.js";
import { mayAlias, type StorageAccess } from "#compiler/function/storage.js";
import {
  bodyEvent,
  eventOperands,
  eventOutput,
  isOperationEvent,
  siteId,
  type BlockId,
  type SiteId,
  type SiteRecord,
  type ValueDemand,
  type WasmBody
} from "#compiler/wasm/function/body.js";
import {
  blockInfo,
  blockPath,
  dominatingSite,
  loopBoundary,
  siteRecord
} from "#compiler/wasm/function/geometry.js";
import { wasmValueId, type WasmValueId } from "#compiler/wasm/function/values/nodes.js";
import { wasmValueSource, type WasmValueNode } from "#compiler/wasm/function/values/nodes.js";
import { canCaptureAfterMandatoryPredecessors } from "./capture-safety.js";
import type { WasmInstructionFusion } from "./fusion.js";
import { liftLoopInvariant } from "./loop-lifting.js";
import { groupHintedUses, groupSelectedUses } from "./use-groups.js";

export type PlacementKind = "atUse" | "capture" | "join";
export type EvaluationKind = PlacementKind | "loopInput";

type EvaluationRecord = Readonly<{
  value: WasmValueId;
  // Loop-input records anchor at their loop header and carry no uses.
  anchor: SiteId;
  uses: readonly SiteId[];
  // Decided by the use-grouping recursion, not derivable from the uses.
  isDefault: boolean;
  operationSite: SiteId | undefined;
}>;

// The complete output of the placement sweep. Local allocation and instruction
// fusion consume these decisions without mutating them.
export type EvaluationPlacement = EvaluationRecord & Readonly<{ kind: PlacementKind }>;

// A finished schedule record. `undefined` local and fusion are final choices,
// not unfinished phase state.
export type WasmEvaluation = EvaluationRecord &
  Readonly<{
    kind: EvaluationKind;
    local: number | undefined;
    fusion: WasmInstructionFusion | undefined;
  }>;

type EvaluationDraft = EvaluationRecord & { kind: PlacementKind | undefined };

export type EvaluationSweep = Readonly<{
  evaluations: readonly EvaluationPlacement[];
  operationsAtAuthoredSite: Uint8Array;
}>;

export function placeEvaluations(body: WasmBody): EvaluationSweep {
  return new EvaluationPlacer(body).place();
}

// Ids are first-demand positions (lower/values.ts). Placement compares
// demand order only through this seam.
export function demandedBefore(candidate: WasmValueId, value: WasmValueId): boolean {
  return candidate < value;
}

// Demand roots in site order: every control operand at its own site, and an
// effectful operation's inputs when it produces no value. The seed list is
// immutable; the sweep logs dead write-producer inputs separately.
export function seedDemandRoots(body: WasmBody): ValueDemand[] {
  const roots: ValueDemand[] = [];

  for (const [index, event] of body.events.entries()) {
    const site = siteId(index);

    if (
      isOperationEvent(event) &&
      (eventOutput(event) !== undefined || body.siteHasWrites[site] === 0)
    ) {
      continue;
    }
    for (const value of eventOperands(event)) {
      roots.push({ value, consumedAt: site });
    }
  }
  return roots;
}

class EvaluationPlacer {
  readonly #demands: (SiteId[] | undefined)[];
  readonly #evaluations: (EvaluationDraft[] | undefined)[];
  readonly #seedRoots: readonly ValueDemand[];
  // Dead write-producer inputs in the order the sweep discovers them. The
  // capture frontier reads the seeds first, then this log.
  readonly #discovered: ValueDemand[] = [];
  // Values in sweep visit order; finalize replays them backward, which is
  // first-demand order.
  readonly #placedValues: WasmValueId[] = [];
  readonly #operationsAtAuthoredSite: Uint8Array;
  constructor(private readonly body: WasmBody) {
    this.#demands = new Array(body.values.length);
    this.#evaluations = new Array(body.values.length);
    this.#seedRoots = seedDemandRoots(body);
    this.#operationsAtAuthoredSite = new Uint8Array(body.sites.length);
  }

  place(): EvaluationSweep {
    for (const site of this.body.operationSites) {
      if (
        eventOutput(bodyEvent(this.body, site)) === undefined &&
        this.body.siteHasWrites[site] !== 0
      ) {
        this.#operationsAtAuthoredSite[site] = 1;
      }
    }
    for (const demand of this.#seedRoots) {
      this.#addDemand(demand.value, demand.consumedAt);
    }

    // Reverse first-demand order: every demand on a value is recorded before
    // the sweep reaches it.
    for (let valueIndex = this.body.values.length - 1; valueIndex >= 0; valueIndex -= 1) {
      const value = wasmValueId(valueIndex);
      const demands = this.#demands[value] ?? [];

      if (demands.length === 0) {
        const producer = this.body.producers[value];

        if (producer !== undefined && this.body.siteHasWrites[producer] !== 0) {
          this.#operationsAtAuthoredSite[producer] = 1;
          for (const input of this.#operands(producer)) {
            this.#discovered.push({ value: input, consumedAt: producer });
            this.#addDemand(input, producer);
          }
        }
        continue;
      }

      const operationProducer = this.body.producers[value];

      if (operationProducer !== undefined) {
        const inputs = this.#operands(operationProducer);
        const anchor = this.#operationAnchor(operationProducer, demands, inputs);

        this.#placeValue(value, anchor, demands, true);
        for (const input of inputs) {
          this.#addDemand(input, anchor);
        }
        continue;
      }

      const joinDependencies = this.body.joinDependencies[value];

      if (joinDependencies !== undefined) {
        const producer = this.body.joinProducers[value];

        assert(producer !== undefined, `join output ${value} has no producer`);
        this.#placeValue(value, producer, demands, true);
        for (const dependency of joinDependencies) {
          this.#addDemand(dependency.value, dependency.consumedAt);
        }
        continue;
      }

      const node = this.body.values.node(value);

      if (isExpression(node)) {
        this.#placeExpressionUses(value, demands, true);
      } else {
        assert(node.kind !== "producerOutput", `output value ${value} has no producer`);
      }
    }

    const ordered: EvaluationPlacement[] = [];

    // Records finalize in first-demand order — the sweep replayed backward.
    // A kind is a per-record fact, so classifying needs no interleaved checks.
    for (let index = this.#placedValues.length - 1; index >= 0; index -= 1) {
      const value = this.#placedValues[index]!;

      for (const draft of this.#evaluations[value] ?? []) {
        draft.kind =
          this.body.joinProducers[value] !== undefined
            ? "join"
            : draft.uses.includes(draft.anchor)
              ? "atUse"
              : "capture";
        ordered.push(draft as EvaluationPlacement);
      }
    }

    return { evaluations: ordered, operationsAtAuthoredSite: this.#operationsAtAuthoredSite };
  }

  #placeValue(
    value: WasmValueId,
    anchor: SiteId,
    uses: readonly SiteId[],
    isDefault: boolean
  ): void {
    let records = this.#evaluations[value];

    if (records === undefined) {
      records = [];
      this.#evaluations[value] = records;
      this.#placedValues.push(value);
    }
    if (buildDefinition.validation) {
      const previous = this.#placedValues[this.#placedValues.length - 2];

      assert(
        previous === undefined || previous > value,
        `value ${value} is logged after ${previous}`
      );
      assert(
        !isDefault || records.every((candidate) => !candidate.isDefault),
        `value ${value} has two default evaluations`
      );
      assert(
        records.every((candidate) => !uses.some((use) => candidate.uses.includes(use))),
        `value ${value} selects two evaluations at one site`
      );
    }
    records.push({
      value,
      anchor,
      uses,
      isDefault,
      operationSite: this.body.producers[value],
      kind: undefined
    });
  }

  #placeExpression(value: WasmValueId, uses: readonly SiteId[], isDefault: boolean): void {
    let anchor = dominatingSite(this.body, uses);

    anchor = liftLoopInvariant(this.body, value, anchor);
    this.#placeValue(value, anchor, uses, isDefault);
    for (const input of this.body.values.node(value).inputs) {
      this.#addDemand(input, anchor);
    }
  }

  #placeExpressionUses(value: WasmValueId, uses: readonly SiteId[], isDefault: boolean): void {
    const selectedGroups = this.body.facts.recipeCanSpeculate(value)
      ? undefined
      : groupSelectedUses(this.body, uses);
    const groups = selectedGroups ?? groupHintedUses(this.body, uses);
    const canShareSelected =
      selectedGroups !== undefined &&
      canCaptureAfterMandatoryPredecessors(
        this.body,
        value,
        dominatingSite(this.body, uses),
        this.#seedRoots,
        this.#discovered
      );

    if (
      groups === undefined ||
      (shouldShareEvaluation(this.body, value) &&
        (selectedGroups === undefined || canShareSelected))
    ) {
      this.#placeExpression(value, uses, isDefault);
      return;
    }

    for (const [index, group] of groups.entries()) {
      this.#placeExpressionUses(value, group, isDefault && index === 0);
    }
  }

  #operationAnchor(
    producer: SiteId,
    demands: readonly SiteId[],
    inputs: readonly WasmValueId[]
  ): SiteId {
    let anchor = dominatingSite(this.body, demands);

    anchor = this.#clampBeforeNestedLoop(this.#site(producer).block, anchor);
    if (
      !this.#isAfterProducer(producer, anchor) ||
      this.body.siteHasWrites[producer] !== 0 ||
      inputs.some((input) => !this.body.facts.recipeCanSpeculate(input)) ||
      this.#crossesAliasingWrite(this.#reads(producer), producer, anchor)
    ) {
      return producer;
    }
    return anchor;
  }

  #clampBeforeNestedLoop(producerBlock: BlockId, anchor: SiteId): SiteId {
    const path = blockPath(this.body, producerBlock, this.#site(anchor).block);

    assert(path !== undefined, "producer demand leaves its producer scope");
    for (const step of path) {
      if (loopBoundary(this.body, step.block) !== undefined) {
        return step.ownerSite;
      }
    }
    return anchor;
  }

  #isAfterProducer(producer: SiteId, anchor: SiteId): boolean {
    const producerSite = this.#site(producer);
    const anchorSite = this.#site(anchor);

    if (producerSite.block === anchorSite.block) {
      return anchorSite.nodeIndex > producerSite.nodeIndex;
    }

    const first = blockPath(this.body, producerSite.block, anchorSite.block)?.[0];

    if (first === undefined) {
      return false;
    }
    const owner = this.#site(first.ownerSite);

    return owner.nodeIndex > producerSite.nodeIndex;
  }

  // The producer and its anchor are separated by one node-index segment per
  // block on the path, so sibling arms never contribute their writes.
  #crossesAliasingWrite(
    reads: readonly StorageAccess[],
    producerSiteId: SiteId,
    anchorId: SiteId
  ): boolean {
    if (reads.length === 0) {
      return false;
    }
    const producerSite = this.#site(producerSiteId);
    const anchor = this.#site(anchorId);
    const path = blockPath(this.body, producerSite.block, anchor.block);

    assert(path !== undefined, "producer anchor leaves its producer scope");
    let block = producerSite.block;
    let start = producerSite.nodeIndex + 1;

    for (const step of path) {
      const owner = this.#site(step.ownerSite);

      if (hasAliasingWrite(this.body, block, start, owner.nodeIndex, reads)) {
        return true;
      }
      block = step.block;
      start = 0;
    }
    return hasAliasingWrite(this.body, block, start, anchor.nodeIndex, reads);
  }

  #addDemand(value: WasmValueId, consumedAt: SiteId): void {
    this.body.values.node(value);
    const demands = this.#demands[value];

    if (demands === undefined) {
      this.#demands[value] = [consumedAt];
    } else {
      demands.push(consumedAt);
    }
  }

  #operands(site: SiteId): readonly WasmValueId[] {
    return eventOperands(bodyEvent(this.body, site));
  }

  #reads(site: SiteId): readonly StorageAccess[] {
    const reads = this.body.siteReads[site];

    assert(reads !== undefined, `unknown schedule site ${site}`);
    return reads;
  }

  #site(id: SiteId): SiteRecord {
    return siteRecord(this.body, id);
  }
}

function isExpression(node: WasmValueNode): boolean {
  return wasmValueSource(node) === "expression";
}

function shouldShareEvaluation(body: WasmBody, value: WasmValueId): boolean {
  const { values } = body;
  const node = values.node(value);

  // Keep i32 constant masks path-local. This can duplicate them in the module,
  // but only the selected path evaluates its copy.
  return (
    node.kind !== "binary" ||
    node.type !== "i32" ||
    node.operator !== "and" ||
    (values.node(node.inputs[0]).kind !== "const" && values.node(node.inputs[1]).kind !== "const")
  );
}

// Placement may move a read only across intervals with no aliasing write.
// Write sites are ordered, so start at the interval's lower bound rather than
// scanning the whole function body for every candidate anchor.
function hasAliasingWrite(
  body: WasmBody,
  block: BlockId,
  startNodeIndex: number,
  endNodeIndex: number,
  reads: readonly StorageAccess[]
): boolean {
  const { sites } = blockInfo(body, block);
  const start = sites[startNodeIndex];
  const end = sites[endNodeIndex];

  assert(start !== undefined, `block has no site at node index ${startNodeIndex}`);
  assert(end !== undefined, `block has no site at node index ${endNodeIndex}`);
  const { writeSites } = body;
  let low = 0;
  let high = writeSites.length;

  while (low < high) {
    const middle = (low + high) >>> 1;
    const write = writeSites[middle];

    assert(write !== undefined, "missing write site");
    if (write.site < start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let index = low; index < writeSites.length; index += 1) {
    const write = writeSites[index];

    assert(write !== undefined, "missing write site");
    if (write.site >= end) {
      break;
    }
    if (write.writes.some((effect) => reads.some((read) => mayAlias(read, effect)))) {
      return true;
    }
  }
  return false;
}
