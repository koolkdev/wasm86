import type { BlockDefinitionId } from "#ir/block/definitions.js";
import type {
  ExprRecipe,
  ValueSnapshotId
} from "#ir/block/planning/values/index.js";
import type { WasmFunctionBodyEncoder } from "#wasm/encoder/function-body.js";
import type { WasmValueType } from "#wasm/encoder/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { WasmValueCache } from "../cache/locals/index.js";
import {
  bindRecipeChildren,
  emitCompositeExpr
} from "./expressions.js";
import type { WasmSourceReader } from "../sources/storage.js";

export type WasmValueProducer = () => WasmValueType;

export type WasmRecipeEmitter = Readonly<{
  emitRecipe(recipe: ExprRecipe): WasmValueType;
  emitRecipeBody(recipe: ExprRecipe): WasmValueType;
  establishSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe): void;
}>;

export type WasmDefinitionRecipeInfo =
  | Readonly<{
      kind: "memoryLoad";
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "dynamicRegisterLoad";
      width: OperandWidth;
    }>;

export type WasmDefinitionRecipeEmitter = Readonly<{
  definitionInfo(definition: BlockDefinitionId): WasmDefinitionRecipeInfo | undefined;
  emitDefinition(
    definition: BlockDefinitionId,
    emitInput: WasmValueProducer,
    options?: { signed?: boolean }
  ): WasmValueType;
}>;

export type WasmRecipeEmitterInput = Readonly<{
  body: WasmFunctionBodyEncoder;
  cache: WasmValueCache;
  definitions: WasmDefinitionRecipeEmitter;
  sources: WasmSourceReader;
}>;

export function createWasmRecipeEmitter(input: WasmRecipeEmitterInput): WasmRecipeEmitter {
  return new WasmRecipeEmitterState(input);
}

class WasmRecipeEmitterState implements WasmRecipeEmitter {
  readonly #body: WasmFunctionBodyEncoder;
  readonly #cache: WasmValueCache;
  readonly #definitions: WasmDefinitionRecipeEmitter;
  readonly #sources: WasmSourceReader;

  constructor(input: WasmRecipeEmitterInput) {
    this.#body = input.body;
    this.#cache = input.cache;
    this.#definitions = input.definitions;
    this.#sources = input.sources;
  }

  emitRecipe(recipe: ExprRecipe): WasmValueType {
    return this.#cache.emitRecipe(recipe, () => this.emitRecipeBody(recipe));
  }

  emitRecipeBody(recipe: ExprRecipe): WasmValueType {
    switch (recipe.kind) {
      case "snapshot":
        return this.#cache.emitSnapshot(recipe.snapshot);
      case "definition":
        return this.#definitions.emitDefinition(
          recipe.definition,
          () => this.emitRecipe(recipe.input)
        );
      case "expr":
        return emitCompositeExpr(
          this.#body,
          recipe,
          bindRecipeChildren(recipe, {
            emitRecipe: (child) => this.emitRecipe(child),
            isRecipeSelected: (child) => this.#cache.isRecipeSelected(child)
          }),
          {
            definitions: this.#definitions,
            emitRecipe: (child) => this.emitRecipe(child),
            isRecipeSelected: (child) => this.#cache.isRecipeSelected(child),
            sources: this.#sources
          }
        );
    }
  }

  establishSnapshot(snapshot: ValueSnapshotId, recipe: ExprRecipe): void {
    this.#cache.ensureSnapshot(snapshot, recipe, () => this.emitRecipeBody(recipe));
  }
}
