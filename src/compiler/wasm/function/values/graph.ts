import { assert } from "#common/assert.js";
import type { WasmValueId } from "./nodes.js";
import type { WasmValueNode } from "./nodes.js";

export class WasmValueGraph {
  // Nodes follow dependency order, and inputs preserve Wasm operand evaluation order.
  readonly #nodes: readonly WasmValueNode[];

  constructor(nodes: readonly WasmValueNode[]) {
    // Finishing transfers the builder-private array across a one-way ownership
    // boundary, so the graph retains it without a copy.
    this.#nodes = nodes;
  }

  get length(): number {
    return this.#nodes.length;
  }

  node(id: WasmValueId): WasmValueNode {
    const node = this.#nodes[id];

    assert(node !== undefined, "unknown Wasm value");
    return node;
  }
}
