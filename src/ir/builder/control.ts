import { assert } from "#common/assert.js";
import type { LoopBody, SemanticOps } from "#x86/semantics/builder.js";
import {
  type BranchHint,
  bodyCompletes
} from "../actions.js";
import type { Body } from "../block.js";
import { BodyBuilder, type BuildBody } from "../body-builder.js";
import {
  dedupeDisjointChannels,
  type StateChannel
} from "../slots.js";
import type { ValueId } from "../values.js";
import { LoopSemanticsBuilderImpl } from "./loop.js";
import type { OperandResolver } from "./operands.js";
import type { SemanticScopeStack } from "./scope.js";
import type { State } from "./state/index.js";
import type { StateWriteLog } from "./state/write-log.js";

type ScopedBody = Readonly<{
  body: Body;
  terminating: boolean;
  joinedChannels: readonly StateChannel[];
}>;

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

  if(condition: ValueId, emitThenBody: BuildBody, hint?: BranchHint): void {
    const parent = this.#scopes.current.body;
    const conditionValue = parent.values.constValue(condition);

    if (conditionValue !== undefined) {
      // Fold when the condition is a constant.
      if (conditionValue !== 0) {
        emitThenBody(parent);
      }

      return;
    }

    const scoped = this.#scopedBody(emitThenBody);
    const elseBody = scoped.terminating ? undefined : this.#skippedBody(scoped.joinedChannels);

    parent.push({
      kind: "if",
      condition,
      ...(hint !== undefined ? { hint } : {}),
      thenBody: scoped.body,
      ...(elseBody !== undefined ? { elseBody } : {})
    });

    if (!scoped.terminating) {
      this.#closeJoinedChannels(scoped.joinedChannels);
    }
  }

  runLoopBody<T>(
    bodyBuilder: BodyBuilder,
    body: LoopBody,
    finish: (condition: ValueId) => T
  ): T {
    return this.#scopes.enter("loop", bodyBuilder, (scope) => {
      const loopBuilder = new LoopSemanticsBuilderImpl({
        host: this.#host,
        state: this.#state,
        operands: this.#operands
      });
      const outcome = scope.run(() => body(loopBuilder, bodyBuilder.values));

      assert(outcome.kind === "fallthrough", "a loop body must not terminate the instruction");
      scope.commitMemoryWrites();
      return finish(outcome.result);
    });
  }

  #scopedBody(emitBody: BuildBody): ScopedBody {
    const writeCheckpoint = this.#writeLog.checkpoint();

    return this.#state.enterScope(() => {
      const child = new BodyBuilder(this.#scopes.current.body.values);

      return this.#scopes.enter("arm", child, (scope) => {
        scope.run(() => emitBody(child));
        const terminating = bodyCompletes(child.build());
        let joinedChannels: readonly StateChannel[] = [];

        if (!terminating) {
          joinedChannels = dedupeDisjointChannels(this.#writeLog.writtenChannelsSince(writeCheckpoint));
          this.#commitJoinedChannels(child, joinedChannels);
          scope.commitMemoryWrites();
        }

        return { body: child.build(), terminating, joinedChannels };
      });
    });
  }

  #commitJoinedChannels(body: BodyBuilder, channels: readonly StateChannel[]): void {
    this.#emitDirtyChannelCommits(body, channels);
  }

  #skippedBody(channels: readonly StateChannel[]): Body | undefined {
    const body = new BodyBuilder(this.#scopes.current.body.values);

    if (!this.#emitDirtyChannelCommits(body, channels)) {
      return undefined;
    }

    return body.build();
  }

  #emitDirtyChannelCommits(body: BodyBuilder, channels: readonly StateChannel[]): boolean {
    let emitted = false;

    for (const channel of channels) {
      if (this.#state.isChannelDirty(channel)) {
        body.op({ kind: "state.write", slot: channel, value: this.#state.readChannel(channel) });
        emitted = true;
      }
    }

    return emitted;
  }

  #closeJoinedChannels(channels: readonly StateChannel[]): void {
    for (const channel of channels) {
      this.#state.invalidate(channel);
      this.#writeLog.recordStateWrite(channel);
    }

    if (channels.some((channel) => channel.kind === "lazyFlags")) {
      this.#state.statusFlags.resetToInputs();
    }
  }
}
