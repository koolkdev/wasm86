import { assert } from "#common/assert.js";
import type {
  BlockDefinition,
  BlockDefinitionId
} from "#ir/block/definitions.js";
import type { DefinitionResult } from "#ir/block/planning/barrier-facts.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import {
  emitLoadGuestMemoryUnchecked
} from "../ops/memory.js";
import type {
  WasmDefinitionRecipeEmitter,
  WasmDefinitionRecipeInfo,
  WasmValueProducer
} from "../values/recipes.js";
import type { WasmEmittedValue } from "../values/types.js";

export type WasmDefinitionRecipeEmitterInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  definitions: readonly DefinitionResult[];
}>;

export function createWasmDefinitionRecipeEmitter(
  input: WasmDefinitionRecipeEmitterInput
): WasmDefinitionRecipeEmitter {
  const state = new WasmDefinitionRecipeEmitterState(input);

  return {
    definitionInfo: (definition) => state.definitionInfo(definition),
    emitDefinition: (definition, emitInput, options) =>
      state.emitDefinition(definition, emitInput, options)
  };
}

class WasmDefinitionRecipeEmitterState {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #definitions = new Map<BlockDefinitionId, BlockDefinition>();

  constructor(input: WasmDefinitionRecipeEmitterInput) {
    this.#body = input.body;

    for (const definition of input.definitions) {
      this.#definitions.set(definition.id, definition.site.definition);
    }
  }

  definitionInfo(definition: BlockDefinitionId): WasmDefinitionRecipeInfo | undefined {
    const site = this.#definitions.get(definition);

    if (site === undefined) {
      return undefined;
    }

    switch (site.kind) {
      case "memoryLoad":
        return { kind: "memoryLoad", width: site.width };
      case "dynamicRegisterLoad":
        return { kind: "dynamicRegisterLoad", width: site.width };
    }
  }

  emitDefinition(
    definition: BlockDefinitionId,
    emitInput: WasmValueProducer,
    options?: { signed?: boolean }
  ): WasmEmittedValue {
    const site = this.#definitions.get(definition);

    assert(site !== undefined, `unknown Wasm block definition ${definition}`);

    switch (site.kind) {
      case "memoryLoad":
        return emitLoadGuestMemoryUnchecked(
          this.#body,
          emitInput,
          site.width,
          options?.signed === true
        );
      case "dynamicRegisterLoad":
        throw new Error("Wasm dynamicRegisterLoad definition lowering is unsupported");
    }
  }
}
