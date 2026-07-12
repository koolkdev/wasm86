import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { FunctionRef, ResourceRef } from "#compiler/program/refs.js";
import type { LegacyFunctionBindings } from "#compiler/program/legacy-body.js";
import type { IrBlock } from "#ir/block.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { emitActionFunction } from "#wasm/emit/action.js";
import type { BlockLiveness } from "#wasm/emit/liveness.js";
import { helperFunctionName, type HelperCallKey } from "#wasm/helpers/key.js";
import {
  LegacyHelperIndexRegistryAdapter,
  type LegacyHelperIndexBinding
} from "#wasm/helpers/registry.js";
import type { LegacyNumericLinkAdapter } from "./legacy-numeric-link.js";

export type JitHelperBinding = Readonly<{
  key: HelperCallKey;
  ref: FunctionRef;
}>;

type LegacyActionEmbeddingAdapterOptions = Readonly<{
  ir: IrBlock;
  liveness: BlockLiveness;
  helperBindings: readonly JitHelperBinding[];
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

    const helperBindings = this.#options.helperBindings.map((helper): LegacyHelperIndexBinding => {
      const functionIndex = bindings.functions.get(helper.ref);

      assert(functionIndex !== undefined, `missing resolved JIT helper ${helperFunctionName(helper.key)}`);
      return { key: helper.key, functionIndex };
    });
    return emitActionFunction(this.#options.ir, {
      helpers: new LegacyHelperIndexRegistryAdapter(helperBindings),
      liveness: this.#options.liveness,
      embedding: { dispatch: this.#options.links.resolve(bindings) }
    });
  }
}
