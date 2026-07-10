import { assert } from "#common/assert.js";
import type { Body } from "#ir/block.js";
import type { ValueId } from "#ir/values.js";
import type { Producer, ScheduleSite } from "./demands.js";

export type ProducerEvent = Readonly<{
  output: ValueId;
  producer: Producer;
  site: ScheduleSite;
  delivery: "capture" | "use";
}>;

export type ProducerEventIndex = Readonly<{
  event(output: ValueId): ProducerEvent | undefined;
  events(): readonly ProducerEvent[];
  capturesAt(body: Body, actionIndex: number): readonly ProducerEvent[];
}>;

export type ProducerSchedule = ProducerEventIndex & Readonly<{
  inputsForBody(body: Body): readonly ValueId[];
}>;

export function createProducerSchedule(
  events: ProducerEventIndex,
  inputsByBody: ReadonlyMap<Body, readonly ValueId[]>
): ProducerSchedule {
  return {
    ...events,
    inputsForBody: (body) => {
      const inputs = inputsByBody.get(body);

      assert(inputs !== undefined, "body is not part of the producer schedule");
      return inputs;
    }
  };
}

export function indexProducerEvents(
  events: readonly ProducerEvent[]
): ProducerEventIndex {
  // Value ids are topological, so output order also puts a same-site
  // producer's dependencies before the producer itself.
  const ordered = [...events].sort((a, b) => a.output - b.output);
  const byOutput = new Map<ValueId, ProducerEvent>();
  const mutableCaptures = new Map<Body, Map<number, ProducerEvent[]>>();

  for (const event of ordered) {
    byOutput.set(event.output, event);
    if (event.delivery !== "capture") {
      continue;
    }

    const byIndex = mutableCaptures.get(event.site.body) ?? new Map();
    const atIndex = byIndex.get(event.site.actionIndex) ?? [];

    atIndex.push(event);
    byIndex.set(event.site.actionIndex, atIndex);
    mutableCaptures.set(event.site.body, byIndex);
  }

  for (const byIndex of mutableCaptures.values()) {
    for (const eventsAtSite of byIndex.values()) {
      eventsAtSite.sort((a, b) => a.output - b.output);
    }
  }

  return {
    event: (output) => byOutput.get(output),
    events: () => ordered,
    capturesAt: (body, actionIndex) =>
      mutableCaptures.get(body)?.get(actionIndex) ?? []
  };
}

export function sameSite(a: ScheduleSite, b: ScheduleSite): boolean {
  return a.body === b.body && a.actionIndex === b.actionIndex;
}
