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
  ActionScheduleEntry,
  BlockScheduleEntry,
  BoundaryScheduleEntry,
  BlockRegisterAccess,
  BlockWalkResult,
  DefinitionScheduleEntry,
  Placement
} from "./result.js";
import type { OpSite } from "./site.js";
import type { BlockState } from "./state.js";

export class BlockWalkRecorder {
  readonly #definitionIds = new BlockDefinitionIds();
  readonly #exitIds = new BlockExitIds();
  readonly #schedule: BlockScheduleEntry[] = [];
  readonly #epochs = new Map<number, number>();
  readonly #exits: BlockExit[] = [];

  result(final: BlockState, registerAccesses: readonly BlockRegisterAccess[]): BlockWalkResult {
    return Object.freeze({
      final,
      schedule: Object.freeze([...this.#schedule]),
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
    const at = this.#placement(action.at);

    this.#schedule.push(Object.freeze({
      role: "action",
      at,
      action
    } satisfies ActionScheduleEntry));
    this.#recordExitBoundaries(action, at);
  }

  stateSync(at: OpSite, state: BlockState): void {
    this.#schedule.push(Object.freeze({
      role: "boundary",
      kind: "stateSync",
      at: this.#placement(at),
      state
    } satisfies BoundaryScheduleEntry));
  }

  #definition(definition: BlockDefinition): void {
    this.#schedule.push(Object.freeze({
      role: "definition",
      at: this.#placement(definition.at),
      definition
    } satisfies DefinitionScheduleEntry));
  }

  #recordExitBoundaries(action: BlockAction, at: Placement): void {
    for (const exit of exitsForAction(action)) {
      this.#schedule.push(Object.freeze({
        role: "boundary",
        kind: "exitState",
        at,
        exit,
        state: exit.snapshot
      } satisfies BoundaryScheduleEntry));
    }
  }

  #placement(at: OpSite): Placement {
    const epoch = this.#epochs.get(at.opIndex) ?? 0;

    this.#epochs.set(at.opIndex, epoch + 1);
    return Object.freeze({ opIndex: at.opIndex, epoch });
  }
}

function exitsForAction(action: BlockAction): readonly BlockExit[] {
  switch (action.kind) {
    case "memoryGuard":
      return [action.faultExit];
    case "jump":
    case "hostTrap":
    case "fallthrough":
      return [action.exit];
    case "branch":
      return [action.taken, action.notTaken];
    case "memoryStore":
    case "dynamicRegisterStore":
      return [];
  }
}
