import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { ResourceRef } from "#compiler/ir/resource.js";
import type { LegacyFunctionBodyContext } from "#compiler/program/legacy-body.js";
import type { IrBlock } from "#ir/block.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { emitActionFunction } from "#wasm/emit/action.js";
import type { LegacyNumericLinkAdapter } from "./legacy-numeric-link.js";

type LegacyActionEmbeddingAdapterOptions = Readonly<{
  ir: IrBlock;
  links: LegacyNumericLinkAdapter;
  cpuState: ResourceRef;
}>;

// Keeps the current IrBlock emitter behind the closed factory contract.
// CPU state still uses its transitional fixed ABI; guest operations resolve
// the resource binding supplied by the closed program.
export class LegacyActionEmbeddingAdapter {
  readonly #options: LegacyActionEmbeddingAdapterOptions;

  constructor(options: LegacyActionEmbeddingAdapterOptions) {
    this.#options = options;
  }

  build(context: LegacyFunctionBodyContext): EncodedWasmFunctionBody {
    const cpuStateMemoryIndex = context.bindings.resourceIndex(
      this.#options.cpuState
    );

    assert(
      cpuStateMemoryIndex === wasmMemoryIndex.cpuState,
      `unexpected resolved CPU-state memory index: ${String(cpuStateMemoryIndex)}`
    );

    const placement = context.placements.get(this.#options.ir);

    assert(placement !== undefined, "missing placement for JIT IR block");
    return emitActionFunction(this.#options.ir, {
      bindings: context.bindings,
      placement,
      embedding: { dispatch: this.#options.links.resolve(context) }
    });
  }
}
