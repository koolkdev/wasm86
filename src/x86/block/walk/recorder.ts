import type { BlockAction } from "#x86/block/actions.js";
import {
  BlockDefinitionIds,
  definitionExpr,
  definitionValueSource,
  type BlockDefinition
} from "#x86/block/definitions.js";
import {
  BlockExitIds,
  type BlockExit,
  type ExitKind,
  type ExitPayload
} from "#x86/block/exits.js";
import type { ExprRef } from "#x86/expr/types.js";
import type { OperandWidth } from "#x86/isa/types.js";
import type {
  BlockRegisterAccess,
  BlockWalkEvent,
  BlockWalkResult
} from "./result.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class BlockWalkRecorder {
  readonly #definitionIds = new BlockDefinitionIds();
  readonly #exitIds = new BlockExitIds();
  readonly #events: BlockWalkEvent[] = [];
  readonly #exits: BlockExit[] = [];

  result(final: BlockState, registerAccesses: readonly BlockRegisterAccess[]): BlockWalkResult {
    return Object.freeze({
      final,
      events: Object.freeze([...this.#events]),
      registerAccesses: Object.freeze([...registerAccesses]),
      exits: Object.freeze([...this.#exits])
    });
  }

  memoryLoad(at: OpSite, address: ExprRef, width: OperandWidth): ExprRef {
    const id = this.#definitionIds.next();
    const result = definitionValueSource(id);
    const definition = Object.freeze({
      kind: "memoryLoad",
      id,
      at,
      result,
      address,
      width
    } satisfies BlockDefinition);

    this.#definition(definition);
    return definitionExpr(result);
  }

  dynamicRegisterLoad(at: OpSite, index: ExprRef, width: OperandWidth): ExprRef {
    const id = this.#definitionIds.next();
    const result = definitionValueSource(id);
    const definition = Object.freeze({
      kind: "dynamicRegisterLoad",
      id,
      at,
      result,
      index,
      width
    } satisfies BlockDefinition);

    this.#definition(definition);
    return definitionExpr(result);
  }

  exit(
    at: OpSite,
    snapshot: BlockState,
    kind: ExitKind,
    payload: ExitPayload
  ): BlockExit {
    const exit = Object.freeze({
      id: this.#exitIds.next(),
      at,
      kind,
      snapshot,
      payload
    });

    this.#exits.push(exit);
    return exit;
  }

  action(action: BlockAction): void {
    this.#events.push(Object.freeze({ kind: "action", action }));
  }

  #definition(definition: BlockDefinition): void {
    this.#events.push(Object.freeze({ kind: "definition", definition }));
  }
}
