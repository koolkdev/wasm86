import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
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

// Keeps the current IrBlock emitter behind the closed factory contract.
// CPU state still uses its transitional fixed ABI; guest operations resolve
// the resource map supplied by the closed program.
export class LegacyActionEmbeddingAdapter {
  readonly #options: LegacyActionEmbeddingAdapterOptions;

  constructor(options: LegacyActionEmbeddingAdapterOptions) {
    this.#options = options;
  }

  build(bindings: LegacyFunctionBindings): EncodedWasmFunctionBody {
    const cpuStateMemoryIndex = bindings.resources.get(this.#options.cpuState);

    assert(
      cpuStateMemoryIndex === wasmMemoryIndex.cpuState,
      `unexpected resolved CPU-state memory index: ${String(cpuStateMemoryIndex)}`
    );
    assert(
      bindings.resources.has(this.#options.guestMemory),
      "missing resolved guest-memory resource"
    );

    const placement = bindings.placements.get(this.#options.ir);

    assert(placement !== undefined, "missing placement for JIT IR block");
    return emitActionFunction(this.#options.ir, {
      functionIndices: bindings.definitionIndices,
      resourceIndices: bindings.resources,
      placement,
      embedding: { dispatch: this.#options.links.resolve(bindings) }
    });
  }
}
