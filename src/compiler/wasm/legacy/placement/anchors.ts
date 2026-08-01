import { assert } from "#common/assert.js";
import type { FunctionAnalysis, SiteId, ValueDemand } from "#compiler/wasm/legacy/analysis/model.js";
import type { StorageAccess } from "#compiler/ir/effects.js";
import { describeNode } from "#compiler/ir/node.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { mayAlias } from "#compiler/ir/effects.js";
import type { FunctionGraph } from "#compiler/ir/function.js";
import type { Region } from "#compiler/ir/region.js";
import { canCaptureAtDeadline } from "./capture-safety.js";
import { LoopAnchors } from "./loop-anchors.js";

type AnchoredValue = Readonly<{
  anchor: SiteId;
  lastDemand: SiteId;
}>;

export type PlannedValue = AnchoredValue &
  Readonly<{
    kind: "atUse" | "capture" | "control";
  }>;

export function planValueAnchors(
  block: FunctionGraph,
  analysis: FunctionAnalysis
): readonly (PlannedValue | undefined)[] {
  return new AnchorPlanner(block, analysis).plan();
}

class AnchorPlanner {
  readonly #demands = new Map<ValueId, ValueDemand[]>();
  readonly #anchored: (AnchoredValue | undefined)[];
  readonly #loopAnchors: LoopAnchors;

  constructor(
    private readonly block: FunctionGraph,
    private readonly analysis: FunctionAnalysis
  ) {
    this.#anchored = new Array(block.values.size()).fill(undefined);
    this.#loopAnchors = new LoopAnchors(block, analysis);
  }

  plan(): readonly (PlannedValue | undefined)[] {
    for (const demand of this.analysis.roots()) {
      this.#addDemand(demand);
    }

    for (let raw = this.block.values.size() - 1; raw >= 0; raw -= 1) {
      const value = valueId(raw);
      const demands = this.#demands.get(value) ?? [];

      if (!this.analysis.isLive(value)) {
        assert(demands.length === 0, `dead value ${value} has placement demands`);
        continue;
      }

      assert(
        demands.length === this.analysis.useCount(value),
        `value ${value} has ${demands.length} placement demands, expected ` +
          `${this.analysis.useCount(value)}`
      );
      assert(demands.length > 0, `live value ${value} has no placement demands`);

      const producer = this.analysis.producer(value);

      if (producer !== undefined) {
        const anchor = this.#producerAnchor(producer.operation, producer.site, demands);

        this.#placeValue(value, anchor, demands);
        for (const input of producer.inputs) {
          this.#addDemand({ value: input, consumedAt: anchor });
        }
        continue;
      }

      const controlDependencies = this.analysis.controlDependencies(value);

      if (controlDependencies !== undefined) {
        const producer = this.analysis.controlProducer(value);

        assert(producer !== undefined, `control output ${value} has no producer`);
        this.#anchored[value] = {
          anchor: producer.site,
          lastDemand: lastDemand(demands)
        };
        for (const dependency of controlDependencies) {
          // The region-end root is the selected unreachable arm's one concrete
          // occurrence. The join dependency describes the same occurrence.
          if (!this.block.values.isUnreachable(dependency.value)) {
            this.#addDemand(dependency);
          }
        }
        continue;
      }

      let anchor = this.analysis.dominatingSite(demands.map((demand) => demand.consumedAt));
      const mode = this.block.values.captureMode(value);

      if (mode === "compute") {
        anchor = this.#loopAnchors.lift(value, anchor);
        this.#placeValue(value, anchor, demands);
      } else {
        assert(mode === "reemit", `producer value ${value} has no producing operation`);
      }

      for (const child of this.block.values.children(value)) {
        this.#addDemand({ value: child, consumedAt: anchor });
      }
    }

    const anchors = this.#anchored.map((placement) => placement?.anchor);
    const planned = new Array<PlannedValue | undefined>(this.block.values.size()).fill(undefined);

    return this.#anchored.map((placement, raw) => {
      if (placement === undefined) {
        return undefined;
      }
      const value = valueId(raw);
      const demands = this.#demands.get(value);

      assert(demands !== undefined, `value ${value} has no placement demands`);
      const kind =
        this.analysis.controlProducer(value) !== undefined
          ? "control"
          : demands.some((demand) => demand.consumedAt === placement.anchor)
            ? "atUse"
            : "capture";
      const hasLocal = (candidate: ValueId): boolean => {
        const earlier = planned[candidate];
        const other = this.#anchored[candidate];

        return earlier !== undefined
          ? earlier.kind !== "atUse" || this.analysis.useCount(candidate) > 1
          : other !== undefined &&
              (this.analysis.controlProducer(candidate) !== undefined ||
                this.analysis.useCount(candidate) > 1 ||
                this.#dominates(other.anchor, placement.anchor));
      };
      const isAvailableAtCapture = (candidate: ValueId): boolean => {
        if (candidate >= value || !hasLocal(candidate)) {
          return false;
        }
        const other = this.#anchored[candidate];
        const earlier = planned[candidate];

        assert(
          other !== undefined && earlier !== undefined,
          `value ${candidate} has no earlier placement`
        );
        return other.anchor === placement.anchor
          ? earlier.kind === "capture"
          : this.#dominates(other.anchor, placement.anchor);
      };

      if (kind === "capture") {
        assert(
          canCaptureAtDeadline(
            this.block,
            this.analysis,
            anchors,
            value,
            placement.anchor,
            hasLocal,
            isAvailableAtCapture
          ),
          `trapping value ${value} has no legal capture deadline`
        );
      }
      const result: PlannedValue = { ...placement, kind };

      planned[value] = result;
      return result;
    });
  }

  #placeValue(value: ValueId, anchor: SiteId, demands: readonly ValueDemand[]): void {
    assert(this.#anchored[value] === undefined, `value ${value} is realized twice`);
    this.#anchored[value] = {
      anchor,
      lastDemand: lastDemand(demands)
    };
  }

  #producerAnchor(
    operation: Operation,
    producerSite: SiteId,
    demands: readonly ValueDemand[]
  ): SiteId {
    const description = describeNode(operation);
    let anchor = this.analysis.dominatingSite(demands.map((demand) => demand.consumedAt));

    anchor = this.#clampBeforeNestedLoop(this.#site(producerSite).region, anchor);

    if (
      !this.#isAfterProducer(producerSite, anchor) ||
      description.effects.writes.length !== 0 ||
      description.operands.some((input) => !this.block.values.isNonTrapping(input)) ||
      this.#crossesAliasingWrite(operation, producerSite, anchor)
    ) {
      return producerSite;
    }

    return anchor;
  }

  #clampBeforeNestedLoop(producerRegion: Region, anchor: SiteId): SiteId {
    const path = this.analysis.path(producerRegion, this.#site(anchor).region);

    assert(path !== undefined, "producer demand leaves its producer scope");
    for (const step of path) {
      if (this.analysis.isLoopRegion(step.region)) {
        return step.owner;
      }
    }

    return anchor;
  }

  #isAfterProducer(producer: SiteId, anchor: SiteId): boolean {
    const producerSite = this.#site(producer);
    const anchorSite = this.#site(anchor);

    if (producerSite.region === anchorSite.region) {
      return anchorSite.nodeIndex > producerSite.nodeIndex;
    }

    const first = this.analysis.path(producerSite.region, anchorSite.region)?.[0];

    if (first === undefined) {
      return false;
    }
    const owner = this.#site(first.owner);

    return owner.nodeIndex > producerSite.nodeIndex;
  }

  #crossesAliasingWrite(operation: Operation, producerSiteId: SiteId, anchorId: SiteId): boolean {
    const description = describeNode(operation);
    const reads = description.effects.reads;

    if (reads.length === 0) {
      return false;
    }
    const producerSite = this.#site(producerSiteId);
    const anchor = this.#site(anchorId);
    const path = this.analysis.path(producerSite.region, anchor.region);

    assert(path !== undefined, "producer anchor leaves its producer scope");
    let region = producerSite.region;
    let start = producerSite.nodeIndex + 1;

    for (const step of path) {
      const owner = this.#site(step.owner);

      if (this.#rangeAliases(region, start, owner.nodeIndex, reads)) {
        return true;
      }
      region = step.region;
      start = 0;
    }

    return this.#rangeAliases(region, start, anchor.nodeIndex, reads);
  }

  #rangeAliases(
    region: Region,
    start: number,
    end: number,
    reads: readonly StorageAccess[]
  ): boolean {
    for (let index = start; index < end; index += 1) {
      const site = this.analysis.siteOf(region, index);

      if (
        this.analysis.writesAt(site).some((write) => reads.some((read) => mayAlias(read, write)))
      ) {
        return true;
      }
    }

    return false;
  }

  #addDemand(demand: ValueDemand): void {
    this.block.values.node(demand.value);
    const demands = this.#demands.get(demand.value);

    demands === undefined ? this.#demands.set(demand.value, [demand]) : demands.push(demand);
  }

  #site(id: SiteId) {
    const site = this.analysis.sites()[id];

    assert(site !== undefined && site.id === id, `unknown placement site ${id}`);
    return site;
  }

  #dominates(anchor: SiteId, site: SiteId): boolean {
    return this.analysis.dominatingSite([anchor, site]) === anchor;
  }
}

function lastDemand(demands: readonly ValueDemand[]): SiteId {
  const first = demands[0];

  assert(first !== undefined, "cannot find the last of no demands");
  let result = first.consumedAt;

  for (const demand of demands.slice(1)) {
    if (demand.consumedAt > result) {
      result = demand.consumedAt;
    }
  }

  return result;
}
