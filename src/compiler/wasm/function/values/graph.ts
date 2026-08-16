import { assert } from "#common/assert.js";
import type { WasmValueId, WasmValueNode } from "./nodes.js";

export class WasmValueGraph {
  readonly #nodes: readonly WasmValueNode[];
  readonly #cannotSpeculate: ReadonlySet<WasmValueId>;

  constructor(nodes: readonly WasmValueNode[], cannotSpeculate: ReadonlySet<WasmValueId>) {
    this.#nodes = [...nodes];
    this.#cannotSpeculate = new Set(cannotSpeculate);
  }

  get length(): number {
    return this.#nodes.length;
  }

  node(id: WasmValueId): WasmValueNode {
    const node = this.#nodes[id];

    assert(node !== undefined, `unknown Wasm value ${id}`);
    return node;
  }

  // Speculation may execute this node's own instruction before its original
  // demand or on an additional control-flow path. Input evaluations are excluded.
  canSpeculateInstruction(id: WasmValueId): boolean {
    this.node(id);
    return !this.#cannotSpeculate.has(id);
  }
}
