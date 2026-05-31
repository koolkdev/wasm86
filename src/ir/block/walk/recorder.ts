import type { BlockAction } from "#ir/block/actions.js";
import {
  BlockDefinitionIds,
  definitionExpr,
  definitionValueSource,
  type BlockDefinition
} from "#ir/block/definitions.js";
import {
  BlockExitIds,
  type BlockExit,
  type ExitKind,
  type ExitPayload
} from "#ir/block/exits.js";
import type { ExprRef } from "#ir/expr/types.js";
import type { OperandWidth } from "#x86/types.js";
import type {
  BlockActionSite,
  BlockTimelineSite,
  BlockDefinitionSite,
  Placement
} from "#ir/block/timeline.js";
import type { BlockWalkResult } from "./types.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class BlockWalkRecorder {
  readonly #definitionIds = new BlockDefinitionIds();
  readonly #exitIds = new BlockExitIds();
  readonly #timeline: BlockTimelineSite[] = [];
  readonly #epochs = new Map<number, number>();
  readonly #exits: BlockExit[] = [];

  result(entry: BlockState, final: BlockState): BlockWalkResult {
    return Object.freeze({
      entry,
      final,
      timeline: Object.freeze([...this.#timeline]),
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
    const at = this.#placement(action.at);

    this.#timeline.push(Object.freeze({
      kind: "action",
      at,
      action
    } satisfies BlockActionSite));
  }

  #definition(definition: BlockDefinition): void {
    this.#timeline.push(Object.freeze({
      kind: "definition",
      at: this.#placement(definition.at),
      definition
    } satisfies BlockDefinitionSite));
  }

  #placement(at: OpSite): Placement {
    const epoch = this.#epochs.get(at.opIndex) ?? 0;

    this.#epochs.set(at.opIndex, epoch + 1);
    return Object.freeze({ opIndex: at.opIndex, epoch });
  }
}
