import { assert } from "#common/assert.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import { OperandScope } from "./operand-resolver.js";

export type SemanticScopeKind = "root" | "arm" | "loop";

export type SemanticScopeOutcome<T> =
  | Readonly<{ kind: "fallthrough"; result: T }>
  | Readonly<{ kind: "complete" }>;

export class SemanticRegionScope {
  readonly region: RegionBuilder;
  readonly kind: SemanticScopeKind;
  readonly insideLoop: boolean;
  readonly operands: OperandScope;
  readonly #parent: SemanticRegionScope | undefined;
  readonly #completion = Symbol("semanticScopeComplete");
  #running = false;
  #terminated = false;
  #wroteMemory: boolean;

  constructor(
    region: RegionBuilder,
    kind: SemanticScopeKind,
    parent?: SemanticRegionScope
  ) {
    this.region = region;
    this.kind = kind;
    this.insideLoop = kind === "loop" || (parent?.insideLoop ?? false);
    this.#parent = parent;
    this.operands = new OperandScope(parent?.operands);
    this.#wroteMemory = parent?.wroteMemory() ?? false;
  }

  run<T>(build: () => T): SemanticScopeOutcome<T> {
    assert(!this.#running, "semantic scope is already running");
    this.#running = true;

    try {
      try {
        return { kind: "fallthrough", result: build() };
      } catch (error) {
        if (error === this.#completion) {
          return { kind: "complete" };
        }

        throw error;
      }
    } finally {
      this.#running = false;
    }
  }

  reset(): void {
    assert(this.kind === "root", "only the root semantic scope can be reset");
    assert(!this.#running, "cannot reset a running semantic scope");
    this.#terminated = false;
    this.#wroteMemory = false;
    this.operands.clear();
  }

  isTerminated(): boolean {
    return this.#terminated;
  }

  markTerminated(): void {
    assert(!this.#terminated, "the semantic scope is already terminated");
    this.#terminated = true;
  }

  wroteMemory(): boolean {
    return this.#wroteMemory;
  }

  recordMemoryWrite(): void {
    this.#wroteMemory = true;
  }

  commitMemoryWrites(): void {
    if (this.#wroteMemory) {
      this.#parent?.recordMemoryWrite();
    }
  }

  complete(): never {
    assert(this.#running, "cannot complete a semantic scope outside its build callback");
    assert(this.#terminated, "cannot complete a semantic scope without a terminator");
    throw this.#completion;
  }
}

export class SemanticScopeStack {
  readonly root: SemanticRegionScope;
  #current: SemanticRegionScope;

  constructor(rootRegion: RegionBuilder) {
    this.root = new SemanticRegionScope(rootRegion, "root");
    this.#current = this.root;
  }

  get current(): SemanticRegionScope {
    return this.#current;
  }

  enter<T>(
    parent: SemanticRegionScope,
    kind: Exclude<SemanticScopeKind, "root">,
    region: RegionBuilder,
    build: (scope: SemanticRegionScope) => T
  ): T {
    assert(
      this.#current === parent,
      "a semantic region must be entered from the active lexical scope"
    );
    const scope = new SemanticRegionScope(region, kind, parent);

    this.#current = scope;
    try {
      return build(scope);
    } finally {
      this.#current = parent;
    }
  }
}
