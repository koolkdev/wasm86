import { assert } from "#common/assert.js";
import type { WasmValueId, WasmValueNode } from "./nodes.js";

export class WasmValueGraph {
  readonly #nodes: readonly WasmValueNode[];

  constructor(nodes: readonly WasmValueNode[]) {
    this.#nodes = [...nodes];
  }

  get length(): number {
    return this.#nodes.length;
  }

  node(id: WasmValueId): WasmValueNode {
    const node = this.#nodes[id];

    assert(node !== undefined, `unknown Wasm value ${id}`);
    return node;
  }
}
