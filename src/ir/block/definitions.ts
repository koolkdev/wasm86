import { exprInput } from "#ir/expr/builders.js";
import type { ModRmSelector } from "#ir/block/modrm-selector.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { OperandWidth } from "#x86/types.js";
import type { OpSite } from "./walk/site.js";

export type BlockDefinitionId = number & { readonly __blockDefinitionId: unique symbol };

export type DefinitionValueSource = Readonly<{
  kind: "def";
  id: BlockDefinitionId;
}>;

export type BlockDefinition =
  | Readonly<{
      kind: "memoryLoad";
      id: BlockDefinitionId;
      at: OpSite;
      result: DefinitionValueSource;
      address: ExprRef;
      width: OperandWidth;
    }>
  | Readonly<{
      kind: "dynamicRegisterLoad";
      id: BlockDefinitionId;
      at: OpSite;
      result: DefinitionValueSource;
      selector: ModRmSelector;
      width: OperandWidth;
    }>;

export class BlockDefinitionIds {
  #next = 0;

  next(): BlockDefinitionId {
    const id = this.#next;

    this.#next += 1;
    return id as BlockDefinitionId;
  }
}

export function definitionValueSource(id: BlockDefinitionId): DefinitionValueSource {
  return Object.freeze({ kind: "def", id });
}

export function definitionExpr(source: DefinitionValueSource): ExprRef {
  return exprInput({ kind: "def", id: source.id });
}
