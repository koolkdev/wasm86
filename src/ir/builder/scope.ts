import { assert } from "#common/assert.js";
import type { RegionBuilder } from "../region-builder.js";
import { OperandScope } from "./operands.js";

export type SemanticScopeKind = "root" | "arm" | "loop";

export type SemanticScopeOutcome<T> =
  | Readonly<{ kind: "fallthrough"; result: T }>
  | Readonly<{ kind: "complete" }>;

export class SemanticBodyScope {
  readonly body: RegionBuilder;
  readonly kind: SemanticScopeKind;
  readonly operands: OperandScope;
  readonly #parent: SemanticBodyScope | undefined;
  readonly #completion = Symbol("semanticScopeComplete");
  #running = false;
  #terminated = false;
  #wroteMemory: boolean;

  constructor(body: RegionBuilder, kind: SemanticScopeKind, parent?: SemanticBodyScope) {
    this.body = body;
    this.kind = kind;
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
  readonly root: SemanticBodyScope;
  #current: SemanticBodyScope;

  constructor(rootBody: RegionBuilder) {
    this.root = new SemanticBodyScope(rootBody, "root");
    this.#current = this.root;
  }

  get current(): SemanticBodyScope {
    return this.#current;
  }

  enter<T>(
    kind: Exclude<SemanticScopeKind, "root">,
    body: RegionBuilder,
    build: (scope: SemanticBodyScope) => T
  ): T {
    const parent = this.#current;
    const scope = new SemanticBodyScope(body, kind, parent);

    this.#current = scope;
    try {
      return build(scope);
    } finally {
      this.#current = parent;
    }
  }
}
