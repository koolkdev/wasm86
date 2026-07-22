import { assert } from "#common/assert.js";

type Ref = Readonly<{ kind: string; id: string }>;
type Declaration = Readonly<{ ref: Ref }>;

export class Declarations<T extends Declaration> {
  readonly #ordered: T[] = [];
  readonly #byRef = new Map<T["ref"], T>();

  add(declaration: T): void {
    const { ref } = declaration;

    assert(!this.#byRef.has(ref), `duplicate program ${ref.kind} declaration: ${ref.id}`);
    this.#ordered.push(declaration);
    this.#byRef.set(ref, declaration);
  }

  get(ref: T["ref"]): T | undefined {
    return this.#byRef.get(ref);
  }

  all(): readonly T[] {
    return [...this.#ordered];
  }
}
