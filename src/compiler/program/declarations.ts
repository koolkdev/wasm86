import { assert } from "#common/assert.js";

type Ref = Readonly<{ kind: string; id: string }>;
type Declaration = Readonly<{ ref: Ref }>;

export class Declarations<T extends Declaration> implements Iterable<T> {
  readonly #ordered: T[] = [];
  readonly #byRef = new Map<T["ref"], T>();
  readonly #ids = new Set<string>();

  add(declaration: T): void {
    const { ref } = declaration;

    assert(!this.#byRef.has(ref), `duplicate program ${ref.kind} declaration: ${ref.id}`);
    assert(!this.#ids.has(ref.id), `duplicate program ${ref.kind} identity: ${ref.id}`);
    this.#ordered.push(declaration);
    this.#byRef.set(ref, declaration);
    this.#ids.add(ref.id);
  }

  has(ref: T["ref"]): boolean {
    return this.#byRef.has(ref);
  }

  all(): readonly T[] {
    return [...this.#ordered];
  }

  [Symbol.iterator](): Iterator<T> {
    return this.#ordered[Symbol.iterator]();
  }
}
