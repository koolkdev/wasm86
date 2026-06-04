import type { LayoutRegion } from "#ir/block/planning/layout/index.js";
import type { SavedExprId } from "#ir/block/planning/values/index.js";
import type {
  WasmCacheEntryId,
  WasmCacheOccurrence,
  WasmCacheOccurrenceSource,
  WasmCachePlan
} from "../plan/index.js";

export type WasmCacheActiveRegion = {
  region: LayoutRegion;
  schedule: readonly WasmCacheOccurrence[];
  cursor: number;
  remainingByEntry: Map<WasmCacheEntryId, number>;
};

export class WasmCacheScheduleCursor {
  readonly #scheduleByRegion = new Map<LayoutRegion["id"], readonly WasmCacheOccurrence[]>();
  readonly #globalRemainingByEntry: Map<WasmCacheEntryId, number>;
  readonly #regions: WasmCacheActiveRegion[] = [];

  constructor(plan: WasmCachePlan) {
    this.#globalRemainingByEntry = occurrenceCounts(plan.schedule.flatMap((region) => region.occurrences));

    for (const region of plan.schedule) {
      this.#scheduleByRegion.set(region.region, region.occurrences);
    }
  }

  enterRegion(region: LayoutRegion): void {
    const schedule = this.#scheduleByRegion.get(region.id) ?? [];

    this.#regions.push({
      region,
      schedule,
      cursor: 0,
      remainingByEntry: occurrenceCounts(schedule)
    });
  }

  activeRegion(): WasmCacheActiveRegion {
    return this.#regions.at(-1) ?? fail("Wasm value cache has no active layout region");
  }

  leaveRegion(region: LayoutRegion): WasmCacheActiveRegion {
    const active = this.activeRegion();

    if (active.region.id !== region.id) {
      throw new Error(`cannot leave Wasm cache region ${region.id}; active region is ${active.region.id}`);
    }

    this.#regions.pop();
    return active;
  }

  assertActiveComplete(): void {
    const active = this.activeRegion();

    if (active.cursor !== active.schedule.length) {
      throw new Error(
        `cannot leave Wasm cache region ${active.region.id}; ` +
        `unconsumed selected occurrence ${describeOccurrence(active.schedule[active.cursor])}`
      );
    }
  }

  peek(): WasmCacheOccurrence | undefined {
    const region = this.activeRegion();

    return region.schedule[region.cursor];
  }

  consume(occurrence: WasmCacheOccurrence): void {
    const region = this.activeRegion();

    if (region.schedule[region.cursor] !== occurrence) {
      throw new Error(`Wasm cache occurrence cursor mismatch at region ${region.region.id}`);
    }

    region.cursor += 1;
    decrementCount(region.remainingByEntry, occurrence.entry);
    decrementCount(this.#globalRemainingByEntry, occurrence.entry);
  }

  remainingForEntry(entry: WasmCacheEntryId): number {
    return this.#globalRemainingByEntry.get(entry) ?? 0;
  }
}

export function occurrenceHasSaveExprSource(occurrence: WasmCacheOccurrence, saved: SavedExprId): boolean {
  return "source" in occurrence &&
    occurrence.source.kind === "save-expr" &&
    occurrence.source.saved === saved;
}

export function sameSource(left: WasmCacheOccurrenceSource, right: WasmCacheOccurrenceSource): boolean {
  if (left.kind !== right.kind) {
    return false;
  }

  switch (left.kind) {
    case "layout-use":
      return left.use === (right as Extract<WasmCacheOccurrenceSource, { kind: "layout-use" }>).use;
    case "save-expr":
      return left.saved === (right as Extract<WasmCacheOccurrenceSource, { kind: "save-expr" }>).saved;
  }
}

export function describeOccurrence(occurrence: WasmCacheOccurrence | undefined): string {
  if (occurrence === undefined) {
    return "end of region schedule";
  }

  return `${occurrence.kind}#${occurrence.index} entry ${occurrence.entry}`;
}

function occurrenceCounts(occurrences: readonly WasmCacheOccurrence[]): Map<WasmCacheEntryId, number> {
  const counts = new Map<WasmCacheEntryId, number>();

  for (const occurrence of occurrences) {
    counts.set(occurrence.entry, (counts.get(occurrence.entry) ?? 0) + 1);
  }

  return counts;
}

function decrementCount(counts: Map<WasmCacheEntryId, number>, entry: WasmCacheEntryId): void {
  const current = counts.get(entry) ?? 0;

  if (current <= 0) {
    throw new Error(`Wasm cache occurrence count underflow for entry ${entry}`);
  }

  if (current === 1) {
    counts.delete(entry);
    return;
  }

  counts.set(entry, current - 1);
}

function fail(message: string): never {
  throw new Error(message);
}
