import { assert } from "#common/assert.js";
import { stateWrite } from "#compiler/ir/operations/state.js";
import type { LoopBody, SemanticOps } from "#core/semantics/builder.js";
import {
  type BranchHint,
  bodyCompletes
} from "../actions.js";
import type { Body } from "../block.js";
import { RegionBuilder, type BuildBody } from "../region-builder.js";
import {
  channelCovers,
  dedupeDisjointChannels,
  type StateChannel
} from "../slots.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  LoopSemanticsBuilderImpl,
  type LoopMemoryOps
} from "./loop.js";
import type { OperandResolver } from "./operands.js";
import type { SemanticScopeStack } from "./scope.js";
import type { State } from "./state/index.js";
import type { StateWriteLog } from "./state/write-log.js";

export type IfOutcome = "continues" | "completes";

type CompletingArm = Readonly<{
  body: RegionBuilder;
  outcome: "completes";
}>;

type ContinuingArm = Readonly<{
  body: RegionBuilder;
  outcome: "continues";
  writtenChannels: readonly StateChannel[];
  memoryMayBeWritten: boolean;
}>;

type BuiltArm = CompletingArm | ContinuingArm;

export class ControlEmitter {
  readonly #state: State;
  readonly #writeLog: StateWriteLog;
  readonly #scopes: SemanticScopeStack;
  readonly #host: SemanticOps;
  readonly #operands: OperandResolver;

  constructor(
    state: State,
    writeLog: StateWriteLog,
    scopes: SemanticScopeStack,
    host: SemanticOps,
    operands: OperandResolver
  ) {
    this.#state = state;
    this.#writeLog = writeLog;
    this.#scopes = scopes;
    this.#host = host;
    this.#operands = operands;
  }

  if(condition: ValueId, emitThen: BuildBody, hint?: BranchHint): IfOutcome {
    const parent = this.#scopes.current.body;
    const conditionValue = parent.values.constValue(condition);

    if (conditionValue !== undefined) {
      if (conditionValue !== 0) {
        emitThen(parent);
      }
      return "continues";
    }

    const thenArm = this.#buildArm(emitThen);

    this.#emitOneArmedIf(parent, condition, thenArm, hint);
    return "continues";
  }

  ifElse(
    condition: ValueId,
    emitThen: BuildBody,
    emitElse: BuildBody,
    hint?: BranchHint
  ): IfOutcome {
    const parent = this.#scopes.current.body;
    const conditionValue = parent.values.constValue(condition);

    if (conditionValue !== undefined) {
      (conditionValue !== 0 ? emitThen : emitElse)(parent);
      return "continues";
    }

    const thenArm = this.#buildArm(emitThen);
    const elseArm = this.#buildArm(emitElse);

    return this.#emitTwoArmedIf(parent, condition, thenArm, elseArm, hint);
  }

  runLoopBody<T>(
    bodyBuilder: RegionBuilder,
    body: LoopBody,
    finish: (condition: ValueId) => T,
    memory: LoopMemoryOps = this.#host
  ): T {
    return this.#scopes.enter("loop", bodyBuilder, (scope) => {
      const loopBuilder = new LoopSemanticsBuilderImpl({
        host: this.#host,
        memory,
        state: this.#state,
        operands: this.#operands
      });
      const outcome = scope.run(() => body(loopBuilder, bodyBuilder.values));

      assert(outcome.kind === "fallthrough", "a loop body must not terminate the instruction");
      scope.commitMemoryWrites();
      return finish(outcome.result);
    });
  }

  #emitOneArmedIf(
    parent: RegionBuilder,
    condition: ValueId,
    thenArm: BuiltArm,
    hint?: BranchHint
  ): void {
    const implicitElse = thenArm.outcome === "completes"
      ? undefined
      : this.#buildImplicitElse(thenArm.writtenChannels);

    parent.push({
      kind: "if",
      condition,
      ...(hint !== undefined ? { hint } : {}),
      thenBody: thenArm.body.build(),
      ...(implicitElse !== undefined ? { elseBody: implicitElse } : {})
    });

    if (thenArm.outcome === "continues") {
      this.#applyJoinEffects([thenArm], thenArm.writtenChannels);
    }
  }

  #emitTwoArmedIf(
    parent: RegionBuilder,
    condition: ValueId,
    thenArm: BuiltArm,
    elseArm: BuiltArm,
    hint?: BranchHint
  ): IfOutcome {
    const continuingArms = [thenArm, elseArm].filter(armContinues);
    const joinedChannels = dedupeDisjointChannels(
      continuingArms.flatMap((arm) => arm.writtenChannels)
    );

    for (const arm of continuingArms) {
      this.#commitMissingJoinChannels(arm, joinedChannels);
    }

    parent.push({
      kind: "if",
      condition,
      ...(hint !== undefined ? { hint } : {}),
      thenBody: thenArm.body.build(),
      elseBody: elseArm.body.build()
    });

    if (continuingArms.length === 0) {
      return "completes";
    }

    this.#applyJoinEffects(continuingArms, joinedChannels);
    return "continues";
  }

  #buildArm(emitBody: BuildBody): BuiltArm {
    const writeCheckpoint = this.#writeLog.checkpoint();

    return this.#state.enterScope(() => {
      const child = this.#scopes.current.body.child();

      return this.#scopes.enter("arm", child, (scope) => {
        scope.run(() => emitBody(child));
        const completes = bodyCompletes(child.build());

        if (completes) {
          return { body: child, outcome: "completes" };
        }

        const writtenChannels = dedupeDisjointChannels(
          this.#writeLog.writtenChannelsSince(writeCheckpoint)
        );

        this.#flushDirtyChannelsInto(child, writtenChannels);
        return {
          body: child,
          outcome: "continues",
          writtenChannels,
          memoryMayBeWritten: scope.wroteMemory()
        };
      });
    });
  }

  #commitMissingJoinChannels(arm: ContinuingArm, joinedChannels: readonly StateChannel[]): void {
    const missing = joinedChannels.filter((channel) => (
      arm.writtenChannels.every((written) => !sameStateChannel(written, channel))
    ));

    this.#flushDirtyChannelsInto(arm.body, missing);
  }

  #buildImplicitElse(channels: readonly StateChannel[]): Body | undefined {
    const body = this.#scopes.current.body.child();

    if (!this.#flushDirtyChannelsInto(body, channels)) {
      return undefined;
    }

    return body.build();
  }

  #flushDirtyChannelsInto(body: RegionBuilder, channels: readonly StateChannel[]): boolean {
    let emitted = false;

    for (const channel of channels) {
      if (this.#state.isChannelDirty(channel)) {
        body.operation(
          stateWrite.create({ slot: channel, value: this.#state.readChannel(channel) })
        );
        emitted = true;
      }
    }

    return emitted;
  }

  #applyJoinEffects(
    arms: readonly ContinuingArm[],
    joinedChannels: readonly StateChannel[]
  ): void {
    if (arms.some((arm) => arm.memoryMayBeWritten)) {
      this.#scopes.current.recordMemoryWrite();
    }

    this.#invalidateJoinChannels(joinedChannels);
  }

  #invalidateJoinChannels(channels: readonly StateChannel[]): void {
    for (const channel of channels) {
      this.#state.invalidate(channel);
      this.#writeLog.recordStateWrite(channel);
    }

    if (channels.some((channel) => channel.kind === "lazyFlags")) {
      this.#state.statusFlags.resetToInputs();
    }
  }
}

function armContinues(arm: BuiltArm): arm is ContinuingArm {
  return arm.outcome === "continues";
}

function sameStateChannel(a: StateChannel, b: StateChannel): boolean {
  return channelCovers(a, b) && channelCovers(b, a);
}
