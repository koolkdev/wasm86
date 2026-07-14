import { assert } from "#common/assert.js";
import type { Body } from "#ir/block.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import type { ScheduleSite } from "./demands.js";
import {
  sameSite,
  type ProducerEvent,
  type ProducerSchedule
} from "./model.js";

// Applies a verified immutable schedule while encoding. Mutable state is
// limited to the current emission-site stack and exact-once assertions.
export class ProducerScheduleExecutor {
  readonly #schedule: ProducerSchedule;
  readonly #sites: ScheduleSite[] = [];
  readonly #executed = new Set<ValueId>();

  constructor(schedule: ProducerSchedule) {
    this.#schedule = schedule;
  }

  withSite(
    body: Body,
    actionIndex: number,
    capture: (event: ProducerEvent) => void,
    execute: () => void
  ): void {
    const site = { body, actionIndex };

    this.#sites.push(site);
    try {
      for (const event of this.#schedule.capturesAt(body, actionIndex)) {
        capture(this.#execute(event, "capture"));
      }
      execute();
    } finally {
      assert(this.#sites.pop() === site, "producer schedule site stack changed");
    }
  }

  executeUse(output: ValueId): ProducerEvent {
    const event = this.#schedule.event(output);

    assert(event !== undefined, `action output ${output} has no materialization event`);
    const site = this.#sites[this.#sites.length - 1];

    assert(site !== undefined, `action output ${output} used outside an emission site`);
    assert(sameSite(event.site, site), `action output ${output} used before its event`);
    return this.#execute(event, "use");
  }

  assertComplete(): void {
    const missing = this.#schedule
      .events()
      .filter((event) => !this.#executed.has(event.output));

    assert(
      missing.length === 0,
      `producer events never executed: ${missing.map((event) => event.output).join(", ")}`
    );
    assert(this.#sites.length === 0, "producer schedule site was not closed");
  }

  #execute(
    event: ProducerEvent,
    delivery: ProducerEvent["delivery"]
  ): ProducerEvent {
    assert(event.delivery === delivery, `producer ${event.output} has wrong event delivery`);
    assert(!this.#executed.has(event.output), `producer ${event.output} event executed twice`);
    this.#executed.add(event.output);
    return event;
  }
}
