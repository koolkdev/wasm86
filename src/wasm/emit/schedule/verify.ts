import { assert } from "#common/assert.js";
import { effectsOf, mayAlias } from "#ir/aliasing.js";
import type { Body, IrBlock } from "#ir/block.js";
import { opAccess, type StorageAccess } from "#ir/ops.js";
import { valueChildren, valueId, type ValueId } from "#ir/values.js";
import type { BlockLiveness } from "../liveness.js";
import type {
  BodyPathStep,
  DemandAnalysis,
  Producer,
  ScheduleSite,
  ValueDemand
} from "./demands.js";
import {
  sameSite,
  type ProducerEvent,
  type ProducerEventIndex
} from "./model.js";
import type { ValueUses } from "../value-uses.js";
import { ValueTraits } from "../value-traits.js";

export function verifyProducerEvents(
  block: IrBlock,
  liveness: BlockLiveness,
  uses: ValueUses,
  demands: DemandAnalysis,
  schedule: ProducerEventIndex
): void {
  const expected = new Set(
    demands
      .producers()
      .filter((producer) => liveness.isLive(producer.output))
      .map((producer) => producer.output)
  );
  const seen = new Set<number>();
  const traits = new ValueTraits(block.values);

  for (const event of schedule.events()) {
    assert(!seen.has(event.output), `producer ${event.output} has multiple events`);
    seen.add(event.output);
    assert(expected.delete(event.output), `producer ${event.output} must not have an event`);
    assert(schedule.event(event.output) === event, `producer ${event.output} has a stale event index`);
  }

  assert(
    expected.size === 0,
    `live producers without events: ${[...expected].join(", ")}`
  );

  const expectedDemands = reconstructProducerDemands(
    block,
    liveness,
    uses,
    demands,
    schedule,
    traits
  );

  for (const event of schedule.events()) {
    const forProducer = expectedDemands.get(event.output);

    assert(forProducer !== undefined, `event ${event.output} has no analyzed demands`);
    verifyEvent(uses, demands, schedule, traits, event, forProducer);
  }
}

function reconstructProducerDemands(
  block: IrBlock,
  liveness: BlockLiveness,
  uses: ValueUses,
  demands: DemandAnalysis,
  schedule: ProducerEventIndex,
  traits: ValueTraits
): ReadonlyMap<ValueId, readonly ValueDemand[]> {
  const byValue = new Map<ValueId, ValueDemand[]>();
  const byProducer = new Map<ValueId, readonly ValueDemand[]>();
  const add = (demand: ValueDemand): void => {
    const existing = byValue.get(demand.value);

    existing === undefined
      ? byValue.set(demand.value, [demand])
      : existing.push(demand);
  };

  for (const demand of demands.roots()) {
    add(demand);
  }

  for (let rawId = block.values.size() - 1; rawId >= 0; rawId -= 1) {
    const id = valueId(rawId);
    const valueDemands = byValue.get(id) ?? [];

    if (!liveness.isLive(id)) {
      assert(valueDemands.length === 0, `dead value ${id} has verified demand`);
      continue;
    }

    const producer = demands.producer(id);

    if (producer !== undefined) {
      const event = schedule.event(id);

      assert(event !== undefined, `live producer ${id} has no event`);
      byProducer.set(id, valueDemands);
      for (const input of producer.inputs) {
        add({
          value: input,
          requiredAt: event.site,
          consumedAt: event.site
        });
      }
      continue;
    }

    assert(
      valueDemands.length === uses.useCount(id),
      `value ${id} verified demand count changed`
    );

    const controlDependencies = demands.controlDependencies(id);

    if (controlDependencies !== undefined) {
      for (const dependency of controlDependencies) {
        add(dependency);
      }
      continue;
    }

    const computedAt = demands.dominatingSite(
      valueDemands.map((demand) =>
        traits.isNonTrapping(id)
          ? demand.requiredAt
          : demand.consumedAt
      )
    );

    for (const child of valueChildren(block.values.node(id))) {
      add({ value: child, requiredAt: computedAt, consumedAt: computedAt });
    }
  }

  return byProducer;
}

function verifyEvent(
  uses: ValueUses,
  demands: DemandAnalysis,
  schedule: ProducerEventIndex,
  traits: ValueTraits,
  event: ProducerEvent,
  expectedDemands: readonly ValueDemand[]
): void {
  const producer = demands.producer(event.output);

  assert(producer !== undefined, `event ${event.output} has no producer`);
  assert(
    event.producer.output === producer.output &&
      event.producer.action === producer.action &&
      sameSite(event.producer.site, producer.site),
    `event ${event.output} carries the wrong producer`
  );
  assert(
    expectedDemands.length === uses.useCount(event.output),
    `event ${event.output} has wrong use count`
  );

  const path = eventPath(producer, event.site, demands);

  assert(
    event.site.actionIndex >= 0 &&
      event.site.actionIndex <= event.site.body.actions.length,
    `event ${event.output} has an invalid action index`
  );
  for (const step of path) {
    assert(
      !demands.isLoopBody(step.body),
      `producer ${event.output} moves from outside into a loop body`
    );
  }

  if (!sameSite(producer.site, event.site)) {
    assert(
      producer.inputs.every((input) => traits.isNonTrapping(input)),
      `producer ${event.output} moves a trapping input recipe`
    );
  }

  for (const demand of expectedDemands) {
    const projected = projectToBody(demand.consumedAt, event.site.body, demands);

    assert(
      projected !== undefined && projected >= event.site.actionIndex,
      `event ${event.output} at ${event.site.actionIndex} does not dominate ` +
        `demand ${demand.consumedAt.actionIndex}`
    );
  }

  const indexed = schedule.capturesAt(event.site.body, event.site.actionIndex);

  if (event.delivery === "use") {
    assert(
      expectedDemands.some((demand) => sameSite(demand.consumedAt, event.site)),
      `use event ${event.output} has no consuming occurrence`
    );
    const action = event.site.body.actions[event.site.actionIndex];
    const capturesBodiesBeforeOperands =
      action?.kind === "switch" || action?.kind === "loop";
    const hasNestedDemand = expectedDemands.some(
      (demand) => demand.consumedAt.body !== event.site.body
    );

    assert(
      !(capturesBodiesBeforeOperands && hasNestedDemand),
      `use event ${event.output} occurs after nested-body capture`
    );
    assert(!indexed.includes(event), `use event ${event.output} appears in the capture index`);
  } else {
    assert(indexed.includes(event), `capture event ${event.output} is missing from its site index`);
  }

  assertStableWindow(producer, event.site, path);
}

function eventPath(
  producer: Producer,
  event: ScheduleSite,
  demands: DemandAnalysis
): readonly BodyPathStep[] {
  if (event.body === producer.site.body) {
    assert(
      event.actionIndex >= producer.site.actionIndex,
      `event ${producer.output} precedes its producer`
    );
    return [];
  }

  const path = demands.pathFrom(producer.site.body, event.body);

  assert(path !== undefined, `event ${producer.output} leaves its producer scope`);
  const first = path[0];

  assert(first !== undefined, `event ${producer.output} has an empty nested path`);
  assert(
    first.owner.actionIndex > producer.site.actionIndex,
    `event ${producer.output} enters a body before its producer`
  );
  return path;
}

function projectToBody(
  site: ScheduleSite,
  body: Body,
  demands: DemandAnalysis
): number | undefined {
  let current = site;

  while (current.body !== body) {
    const owner = demands.owner(current.body);

    if (owner === undefined) {
      return undefined;
    }
    current = owner;
  }

  return current.actionIndex;
}

function assertStableWindow(
  producer: Producer,
  event: ScheduleSite,
  path: readonly BodyPathStep[]
): void {
  const reads = opAccess(producer.action.op).reads;
  let body = producer.site.body;
  let start = producer.site.actionIndex + 1;

  for (const step of path) {
    assertStableRange(producer.output, body, start, step.owner.actionIndex, reads);
    body = step.body;
    start = 0;
  }

  assertStableRange(producer.output, body, start, event.actionIndex, reads);
}

function assertStableRange(
  output: number,
  body: Body,
  start: number,
  end: number,
  reads: readonly StorageAccess[]
): void {
  for (let index = start; index < end; index += 1) {
    const action = body.actions[index];

    assert(action !== undefined, `missing action ${index} in scheduled body`);
    const crossesWrite = effectsOf(action).writes.some((write) =>
      reads.some((read) => mayAlias(read, write))
    );

    assert(!crossesWrite, `producer ${output} crosses an aliasing write`);
  }
}
