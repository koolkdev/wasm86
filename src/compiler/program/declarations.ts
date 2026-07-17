import { assert } from "#common/assert.js";

type Ref = Readonly<{ kind: string; id: string }>;
type Declaration = Readonly<{ ref: Ref }>;

export class Declarations<T extends Declaration> implements Iterable<T> {
  readonly #ordered: T[] = [];
  readonly #byRef = new Map<T["ref"], T>();

  add(declaration: T): void {
    const { ref } = declaration;

    assert(!this.#byRef.has(ref), `duplicate program ${ref.kind} declaration: ${ref.id}`);
    this.#ordered.push(declaration);
    this.#byRef.set(ref, declaration);
  }

  has(ref: T["ref"]): boolean {
    return this.#byRef.has(ref);
  }

  get(ref: T["ref"]): T | undefined {
    return this.#byRef.get(ref);
  }

  find(predicate: (declaration: T) => boolean): T | undefined {
    return this.#ordered.find(predicate);
  }

  all(): readonly T[] {
    return [...this.#ordered];
  }

  [Symbol.iterator](): Iterator<T> {
    return this.#ordered[Symbol.iterator]();
  }
}
