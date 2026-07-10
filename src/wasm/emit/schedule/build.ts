import { assert } from "#common/assert.js";
import { effectsOf, mayAlias } from "#ir/aliasing.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess } from "#ir/ops.js";
import { nestedBodies } from "#ir/traverse.js";
import { valueChildren, valueId, type ValueId } from "#ir/values.js";
import type { BlockLiveness } from "../liveness.js";
import type {
  ScheduleSite,
  DemandAnalysis,
  Producer,
  ValueDemand
} from "./demands.js";
import {
  createProducerSchedule,
  indexProducerEvents,
  sameSite,
  type ProducerEvent,
  type ProducerEventIndex,
  type ProducerSchedule
} from "./model.js";
import type { ValueUses } from "../value-uses.js";
import { ValueTraits } from "../value-traits.js";
import { analyzeDemands } from "./demands.js";
import { verifyProducerEvents } from "./verify.js";

export function planProducerSchedule(
  block: IrBlock,
  liveness: BlockLiveness,
  uses: ValueUses,
  exportedOutputs: Iterable<ValueId>
): ProducerSchedule {
  const demands = analyzeDemands(block, exportedOutputs);
  const builder = new ScheduleBuilder(block, liveness, uses, demands);
  const events = builder.build();

  verifyProducerEvents(block, liveness, uses, demands, events);
  return createProducerSchedule(events, builder.bodyInputs());
}

class ScheduleBuilder {
  readonly #block: IrBlock;
  readonly #liveness: BlockLiveness;
  readonly #uses: ValueUses;
  readonly #demands: DemandAnalysis;
  readonly #traits: ValueTraits;
  readonly #demandsByValue = new Map<ValueId, ValueDemand[]>();
  readonly #sites = new Map<ValueId, ScheduleSite>();
  readonly #events = new Map<ValueId, ProducerEvent>();

  constructor(
    block: IrBlock,
    liveness: BlockLiveness,
    uses: ValueUses,
    demands: DemandAnalysis
  ) {
    this.#block = block;
    this.#liveness = liveness;
    this.#uses = uses;
    this.#demands = demands;
    this.#traits = new ValueTraits(block.values);
  }

  build(): ProducerEventIndex {
    for (const demand of this.#demands.roots()) {
      this.#addDemand(demand);
    }

    for (let rawId = this.#block.values.size() - 1; rawId >= 0; rawId -= 1) {
      const id = valueId(rawId);
      const valueDemands = this.#demandsByValue.get(id) ?? [];

      if (!this.#liveness.isLive(id)) {
        assert(valueDemands.length === 0, `dead value ${id} has scheduled demand`);
        continue;
      }

      assert(
        valueDemands.length === this.#uses.useCount(id),
        `value ${id} demand count changed`
      );
      const producer = this.#demands.producer(id);

      if (producer !== undefined) {
        const event = this.#scheduleProducer(producer, valueDemands);

        this.#events.set(id, event);
        this.#sites.set(id, event.site);
        for (const input of producer.inputs) {
          this.#addDemand({
            value: input,
            requiredAt: event.site,
            consumedAt: event.site
          });
        }
        continue;
      }

      const controlDependencies = this.#demands.controlDependencies(id);

      if (controlDependencies !== undefined) {
        for (const dependency of controlDependencies) {
          this.#addDemand(dependency);
        }
        continue;
      }

      const computedAt = this.#demands.dominatingSite(
        valueDemands.map((demand) => demand.requiredAt)
      );

      this.#sites.set(id, computedAt);

      for (const child of valueChildren(this.#block.values.node(id))) {
        this.#addDemand({
          value: child,
          requiredAt: computedAt,
          consumedAt: computedAt
        });
      }
    }

    return indexProducerEvents([...this.#events.values()]);
  }

  bodyInputs(): ReadonlyMap<Body, readonly ValueId[]> {
    const mutableInputs = new Map<Body, Set<ValueId>>();
    const visit = (body: Body): void => {
      for (const action of body.actions) {
        for (const nested of nestedBodies(action)) {
          mutableInputs.set(nested, new Set());
          visit(nested);
        }
      }
    };

    visit(this.#block.body);
    // A compound crosses only the first body boundary after its compute site;
    // producer events own their delivery, while leaves can re-emit directly.
    for (const [value, site] of this.#sites) {
      if (
        this.#events.has(value) ||
        valueChildren(this.#block.values.node(value)).length === 0
      ) {
        continue;
      }

      for (const demand of this.#demandsByValue.get(value) ?? []) {
        const path = this.#demands.pathFrom(site.body, demand.consumedAt.body);

        assert(path !== undefined, `value ${value} demand leaves its compute scope`);
        const boundary = path[0]?.body;

        if (boundary !== undefined) {
          const inputs = mutableInputs.get(boundary);

          assert(inputs !== undefined, "demand boundary is not a nested body");
          inputs.add(value);
        }
      }
    }

    return new Map(
      [...mutableInputs].map(([body, inputs]) => [
        body,
        [...inputs].sort((a, b) => a - b)
      ])
    );
  }

  #addDemand(demand: ValueDemand): void {
    this.#block.values.node(demand.value);
    const valueDemands = this.#demandsByValue.get(demand.value);

    valueDemands === undefined
      ? this.#demandsByValue.set(demand.value, [demand])
      : valueDemands.push(demand);
  }

  #scheduleProducer(
    producer: Producer,
    outputDemands: readonly ValueDemand[]
  ): ProducerEvent {
    assert(outputDemands.length > 0, `live producer ${producer.output} has no demands`);
    let site = this.#demands.dominatingSite(
      outputDemands.map((demand) => demand.consumedAt)
    );

    site = this.#clampBeforeNestedLoop(producer.site.body, site);

    if (
      !this.#isAfterProducer(producer.site, site) ||
      producer.inputs.some((input) => !this.#traits.isNonTrapping(input)) ||
      this.#writesCrossWindow(producer, site)
    ) {
      site = producer.site;
    }

    const hasNestedDemand = outputDemands.some(
      (demand) => demand.consumedAt.body !== site.body
    );
    const isDirectUse = outputDemands.some(
      (demand) => sameSite(demand.consumedAt, site)
    );
    const action = site.body.actions[site.actionIndex];
    const capturesBodiesBeforeOperands =
      action?.kind === "switch" || action?.kind === "loop";

    return {
      output: producer.output,
      producer,
      site,
      delivery:
        isDirectUse && !(hasNestedDemand && capturesBodiesBeforeOperands)
          ? "use"
          : "capture"
    };
  }

  #writesCrossWindow(producer: Producer, event: ScheduleSite): boolean {
    const reads = opAccess(producer.action.op).reads;
    const path = this.#demands.pathFrom(producer.site.body, event.body);

    assert(path !== undefined, `event for ${producer.output} leaves its producer scope`);

    let body = producer.site.body;
    let start = producer.site.actionIndex + 1;

    for (const step of path) {
      if (this.#rangeWrites(body, start, step.owner.actionIndex, reads)) {
        return true;
      }
      body = step.body;
      start = 0;
    }

    return this.#rangeWrites(body, start, event.actionIndex, reads);
  }

  #rangeWrites(
    body: Body,
    start: number,
    end: number,
    reads: ReturnType<typeof opAccess>["reads"]
  ): boolean {
    for (let index = start; index < end; index += 1) {
      const action = body.actions[index];

      assert(action !== undefined, `missing action ${index} in scheduled body`);
      if (
        effectsOf(action).writes.some((write) =>
          reads.some((read) => mayAlias(read, write))
        )
      ) {
        return true;
      }
    }

    return false;
  }

  #isAfterProducer(producer: ScheduleSite, event: ScheduleSite): boolean {
    if (producer.body === event.body) {
      return event.actionIndex > producer.actionIndex;
    }

    const first = this.#demands.pathFrom(producer.body, event.body)?.[0];

    return first !== undefined && first.owner.actionIndex > producer.actionIndex;
  }

  #clampBeforeNestedLoop(producerBody: Body, site: ScheduleSite): ScheduleSite {
    const path = this.#demands.pathFrom(producerBody, site.body);

    assert(path !== undefined, "producer demand is outside its producer scope");
    for (const step of path) {
      if (this.#demands.isLoopBody(step.body)) {
        return step.owner;
      }
    }

    return site;
  }
}
