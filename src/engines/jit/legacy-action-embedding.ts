import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { ResourceRef } from "#compiler/program/refs.js";
import type { LegacyFunctionBindings } from "#compiler/program/legacy-body.js";
import type { IrBlock } from "#ir/block.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { emitActionFunction } from "#wasm/emit/action.js";
import type { LegacyNumericLinkAdapter } from "./legacy-numeric-link.js";

type LegacyActionEmbeddingAdapterOptions = Readonly<{
  ir: IrBlock;
  links: LegacyNumericLinkAdapter;
  cpuState: ResourceRef;
  guestMemory: ResourceRef;
}>;

// Keeps the current IrBlock emitter behind the closed factory contract. Its
// fixed memory ABI is asserted against resolved bindings before raw emission.
export class LegacyActionEmbeddingAdapter {
  readonly #options: LegacyActionEmbeddingAdapterOptions;

  constructor(options: LegacyActionEmbeddingAdapterOptions) {
    this.#options = options;
  }

  build(bindings: LegacyFunctionBindings): EncodedWasmFunctionBody {
    const cpuStateMemoryIndex = bindings.resources.get(this.#options.cpuState);
    const guestMemoryIndex = bindings.resources.get(this.#options.guestMemory);

    assert(
      cpuStateMemoryIndex === wasmMemoryIndex.cpuState,
      `unexpected resolved CPU-state memory index: ${String(cpuStateMemoryIndex)}`
    );
    assert(
      guestMemoryIndex === wasmMemoryIndex.guest,
      `unexpected resolved guest-memory index: ${String(guestMemoryIndex)}`
    );

    const placement = bindings.placements.get(this.#options.ir);

    assert(placement !== undefined, "missing placement for JIT IR block");
    return emitActionFunction(this.#options.ir, {
      functionIndices: bindings.definitionIndices,
      placement,
      embedding: { dispatch: this.#options.links.resolve(bindings) }
    });
  }
}
