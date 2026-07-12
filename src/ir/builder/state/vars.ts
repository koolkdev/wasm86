import { assert } from "#common/assert.js";
import { semanticVar } from "#core/semantics/refs.js";
import type { SemanticVar } from "#core/semantics/builder.js";

// Semantic vars are block-local mutable slots: the builder only numbers
// them, var.read/var.write ops carry the index, and the emitter backs each
// index with a wasm local. Indices reset per instruction, so locals recycle
// across instructions; every var's seed write dominates its reads.
export class VarState {
  #nextIndex = 0;

  beginInstruction(): void {
    this.#nextIndex = 0;
  }

  create(): SemanticVar {
    return semanticVar(this.#nextIndex++);
  }

  // Scratch replays run bodies holding var refs created on another builder.
  adopt(count: number): void {
    this.#nextIndex = Math.max(this.#nextIndex, count);
  }

  get count(): number {
    return this.#nextIndex;
  }

  assertKnown(variable: SemanticVar): void {
    assert(variable.index < this.#nextIndex, `unknown semantic var ${variable.index}`);
  }
}
