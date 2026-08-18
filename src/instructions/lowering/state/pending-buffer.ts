import type { I32Value } from "#compiler/function/values.js";

export type StatePathKind = "fault" | "completed";

type PendingEntry<Value> = { value: Value; dirty: boolean };

export type PendingBufferSnapshot<C, Value = I32Value> = Readonly<{
  entries: ReadonlyMap<C, Readonly<PendingEntry<Value>>>;
  boundary: ReadonlyMap<C, Value>;
}>;

// A pending-write buffer with an instruction-boundary snapshot: the
// transactional core shared by the state-field tracker and the alias-keyed GPR
// store. It owns entry tracking, the boundary snapshot, the dirty-since
// query, and the two flush modes (fault restores the snapshot, completed
// publishes the current dirty set). Overlap policy and read caching are the
// stores' own concern; this buffer is key-agnostic.
export class PendingBuffer<C, Value = I32Value> {
  readonly #entries = new Map<C, PendingEntry<Value>>();
  #boundary = new Map<C, Value>();

  get(channel: C): PendingEntry<Value> | undefined {
    return this.#entries.get(channel);
  }

  entries(): IterableIterator<[C, PendingEntry<Value>]> {
    return this.#entries.entries();
  }

  set(channel: C, value: Value): void {
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

  snapshot(): PendingBufferSnapshot<C, Value> {
    return {
      entries: new Map([...this.#entries].map(([channel, entry]) => [channel, { ...entry }])),
      boundary: new Map(this.#boundary)
    };
  }

  restore(snapshot: PendingBufferSnapshot<C, Value>): void {
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
  setBoundary(channel: C, value: Value): void {
    this.#boundary.set(channel, value);
  }

  entriesForPath(path: StatePathKind): ReadonlyArray<readonly [C, Value]> {
    return path === "fault"
      ? [...this.#boundary]
      : [...this.#entries].flatMap(([channel, entry]) =>
          entry.dirty ? [[channel, entry.value] as const] : []
        );
  }
}
