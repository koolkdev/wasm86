import { assert } from "#common/assert.js";
import type { EncodedWasmFunctionBody } from "#compiler/encoder/function-body.js";
import type { LegacyFunctionBodyContext } from "#compiler/program/legacy-body.js";
import type { IrBlock } from "#ir/block.js";
import { emitActionFunction } from "#wasm/emit/action.js";
import type { LegacyNumericLinkAdapter } from "./legacy-numeric-link.js";

type LegacyActionEmbeddingAdapterOptions = Readonly<{
  ir: IrBlock;
  links: LegacyNumericLinkAdapter;
}>;

// Keeps the current IrBlock emitter behind the closed factory contract.
export class LegacyActionEmbeddingAdapter {
  readonly #options: LegacyActionEmbeddingAdapterOptions;

  constructor(options: LegacyActionEmbeddingAdapterOptions) {
    this.#options = options;
  }

  build(context: LegacyFunctionBodyContext): EncodedWasmFunctionBody {
    const placement = context.placements.get(this.#options.ir);

    assert(placement !== undefined, "missing placement for JIT IR block");
    return emitActionFunction(this.#options.ir, {
      bindings: context.bindings,
      placement,
      embedding: { dispatch: this.#options.links.resolve(context) }
    });
  }
}
