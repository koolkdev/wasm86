import { assert } from "#common/assert.js";
import type {
  BodyAnalysis,
  SiteId,
  ValueDemand
} from "#compiler/analysis/model.js";
import type { StorageAccess } from "#compiler/ir/operations/definition.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { mayAlias } from "#ir/aliasing.js";
import type { OpAction } from "#ir/actions.js";
import type { Body, IrBlock } from "#ir/block.js";
import { canCaptureAtDeadline } from "./capture-safety.js";

type AnchoredValue = Readonly<{
  anchor: SiteId;
  lastDemand: SiteId;
}>;

export type PlannedValue = AnchoredValue & Readonly<{
  kind: "atUse" | "capture" | "control";
}>;

export function planValueAnchors(
  block: IrBlock,
  analysis: BodyAnalysis
): readonly (PlannedValue | undefined)[] {
  return new AnchorPlanner(block, analysis).plan();
}

class AnchorPlanner {
  readonly #demands = new Map<ValueId, ValueDemand[]>();
  readonly #anchored: (AnchoredValue | undefined)[];

  constructor(
    private readonly block: IrBlock,
    private readonly analysis: BodyAnalysis
  ) {
    this.#anchored = new Array(block.values.size()).fill(undefined);
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
        const anchor = this.#producerAnchor(producer.action, producer.site, demands);

        this.#placeValue(value, anchor, demands);
        for (const input of producer.inputs) {
          this.#addDemand({
            value: input,
            requiredAt: anchor,
            consumedAt: anchor
          });
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
          // The body-end root is the selected unreachable arm's one concrete
          // occurrence. The join dependency describes the same occurrence.
          if (!this.block.values.isUnreachable(dependency.value)) {
            this.#addDemand(dependency);
          }
        }
        continue;
      }

      const anchor = this.analysis.dominatingSite(
        demands.map((demand) =>
          this.block.values.isNonTrapping(value)
            ? demand.requiredAt
            : demand.consumedAt
        )
      );
      const mode = this.block.values.captureMode(value);

      if (mode === "compute") {
        this.#placeValue(value, anchor, demands);
      } else {
        assert(mode === "reemit", `producer value ${value} has no producer action`);
      }

      for (const child of this.block.values.children(value)) {
        this.#addDemand({ value: child, requiredAt: anchor, consumedAt: anchor });
      }
    }

    const anchors = this.#anchored.map((placement) => placement?.anchor);
    const planned = new Array<PlannedValue | undefined>(
      this.block.values.size()
    ).fill(undefined);

    return this.#anchored.map((placement, raw) => {
      if (placement === undefined) {
        return undefined;
      }
      const value = valueId(raw);
      const demands = this.#demands.get(value);

      assert(demands !== undefined, `value ${value} has no placement demands`);
      const kind = this.analysis.controlProducer(value) !== undefined
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

  #placeValue(
    value: ValueId,
    anchor: SiteId,
    demands: readonly ValueDemand[]
  ): void {
    assert(this.#anchored[value] === undefined, `value ${value} is realized twice`);
    this.#anchored[value] = {
      anchor,
      lastDemand: lastDemand(demands)
    };
  }

  #producerAnchor(
    action: OpAction,
    producerSite: SiteId,
    demands: readonly ValueDemand[]
  ): SiteId {
    let anchor = this.analysis.dominatingSite(
      demands.map((demand) => demand.consumedAt)
    );

    anchor = this.#clampBeforeNestedLoop(this.#site(producerSite).body, anchor);

    if (
      !this.#isAfterProducer(producerSite, anchor) ||
      action.op.inputs.some(
        (input) => !this.block.values.isNonTrapping(input.value)
      ) ||
      this.#crossesAliasingWrite(action, producerSite, anchor)
    ) {
      return producerSite;
    }

    return anchor;
  }

  #clampBeforeNestedLoop(producerBody: Body, anchor: SiteId): SiteId {
    const path = this.analysis.path(producerBody, this.#site(anchor).body);

    assert(path !== undefined, "producer demand leaves its producer scope");
    for (const step of path) {
      if (this.analysis.isLoopBody(step.body)) {
        return step.owner;
      }
    }

    return anchor;
  }

  #isAfterProducer(producer: SiteId, anchor: SiteId): boolean {
    const producerSite = this.#site(producer);
    const anchorSite = this.#site(anchor);

    if (producerSite.body === anchorSite.body) {
      return anchorSite.actionIndex > producerSite.actionIndex;
    }

    const first = this.analysis.path(producerSite.body, anchorSite.body)?.[0];

    if (first === undefined) {
      return false;
    }
    const owner = this.#site(first.owner);

    return owner.actionIndex > producerSite.actionIndex;
  }

  #crossesAliasingWrite(
    action: OpAction,
    producerSiteId: SiteId,
    anchorId: SiteId
  ): boolean {
    const reads = action.op.effects.reads;

    if (reads.length === 0) {
      return false;
    }
    const producerSite = this.#site(producerSiteId);
    const anchor = this.#site(anchorId);
    const path = this.analysis.path(producerSite.body, anchor.body);

    assert(path !== undefined, "producer anchor leaves its producer scope");
    let body = producerSite.body;
    let start = producerSite.actionIndex + 1;

    for (const step of path) {
      const owner = this.#site(step.owner);

      if (this.#rangeAliases(body, start, owner.actionIndex, reads)) {
        return true;
      }
      body = step.body;
      start = 0;
    }

    return this.#rangeAliases(body, start, anchor.actionIndex, reads);
  }

  #rangeAliases(
    body: Body,
    start: number,
    end: number,
    reads: readonly StorageAccess[]
  ): boolean {
    for (let index = start; index < end; index += 1) {
      const site = this.analysis.siteOf(body, index);

      if (
        this.analysis.writesAt(site).some((write) =>
          reads.some((read) => mayAlias(read, write))
        )
      ) {
        return true;
      }
    }

    return false;
  }

  #addDemand(demand: ValueDemand): void {
    this.block.values.node(demand.value);
    const demands = this.#demands.get(demand.value);

    demands === undefined
      ? this.#demands.set(demand.value, [demand])
      : demands.push(demand);
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
