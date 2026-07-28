import type { ValueId } from "#compiler/ir/values/types.js";

export type StatePathKind = "fault" | "completed";

type PendingEntry = { value: ValueId; dirty: boolean };

export type PendingBufferSnapshot<C> = Readonly<{
  entries: ReadonlyMap<C, Readonly<PendingEntry>>;
  boundary: ReadonlyMap<C, ValueId>;
}>;

// A pending-write buffer with an instruction-boundary snapshot: the
// transactional core shared by the state-field tracker and the alias-keyed GPR
// store. It owns entry tracking, the boundary snapshot, the dirty-since
// query, and the two flush modes (fault restores the snapshot, completed
// publishes the current dirty set). Overlap policy and read caching are the
// stores' own concern; this buffer is key-agnostic.
export class PendingBuffer<C> {
  readonly #entries = new Map<C, PendingEntry>();
  #boundary = new Map<C, ValueId>();

  get(channel: C): PendingEntry | undefined {
    return this.#entries.get(channel);
  }

  entries(): IterableIterator<[C, PendingEntry]> {
    return this.#entries.entries();
  }

  set(channel: C, value: ValueId): void {
    this.#entries.set(channel, { value, dirty: true });
  }

  // Keeps the tracked value for later reads but records it as flushed.
  markClean(channel: C): void {
    const entry = this.#entries.get(channel);

    if (entry !== undefined) {
      entry.dirty = false;
    }
  }

  delete(channel: C): void {
    this.#entries.delete(channel);
  }

  clear(): void {
    this.#entries.clear();
  }

  snapshot(): PendingBufferSnapshot<C> {
    return {
      entries: new Map([...this.#entries].map(([channel, entry]) => [channel, { ...entry }])),
      boundary: new Map(this.#boundary)
    };
  }

  restore(snapshot: PendingBufferSnapshot<C>): void {
    this.#entries.clear();

    for (const [channel, entry] of snapshot.entries) {
      this.#entries.set(channel, { ...entry });
    }

    this.#boundary = new Map(snapshot.boundary);
  }

  has(channel: C): boolean {
    return this.#entries.has(channel);
  }

  snapshotBoundary(): void {
    this.#boundary = new Map([...this.#entries].map(([channel, entry]) => [channel, entry.value]));
  }

  boundaryHas(channel: C): boolean {
    return this.#boundary.has(channel);
  }

  // Records a channel's pre-instruction value before a flush overwrites it in
  // memory, so the fault path can still restore it.
  setBoundary(channel: C, value: ValueId): void {
    this.#boundary.set(channel, value);
  }

  entriesForPath(path: StatePathKind): ReadonlyArray<readonly [C, ValueId]> {
    return path === "fault"
      ? [...this.#boundary]
      : [...this.#entries].flatMap(([channel, entry]) =>
          entry.dirty ? [[channel, entry.value] as const] : []
        );
  }
}
