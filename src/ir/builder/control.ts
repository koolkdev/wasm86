import { assert } from "#common/assert.js";
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
import type { State } from "./state/index.js";
import type { StateWriteLog } from "./state/write-log.js";

export type RunInBody = (body: BodyBuilder, build: BuildBody) => void;

type ScopedBody = Readonly<{
  body: Body;
  terminating: boolean;
  joinedChannels: readonly StateChannel[];
}>;

export class ControlEmitter {
  readonly #state: State;
  readonly #writeLog: StateWriteLog;
  readonly #currentBody: () => BodyBuilder;
  readonly #runInBody: RunInBody;

  constructor(
    state: State,
    writeLog: StateWriteLog,
    currentBody: () => BodyBuilder,
    runInBody: RunInBody
  ) {
    this.#state = state;
    this.#writeLog = writeLog;
    this.#currentBody = currentBody;
    this.#runInBody = runInBody;
  }

  if(condition: ValueId, emitThenBody: BuildBody, hint?: BranchHint): void {
    const parent = this.#currentBody();

    // If the condition is a constant false, the then body is unreachable and can be skipped.
    if (parent.values.constValue(condition) === 0) {
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

  #scopedBody(emitBody: BuildBody): ScopedBody {
    const writeCheckpoint = this.#writeLog.checkpoint();

    return this.#state.enterScope(() => {
      const child = new BodyBuilder(this.#currentBody().values);
      let body: Body | undefined;
      let terminating = false;
      let joinedChannels: readonly StateChannel[] = [];

      this.#runInBody(child, (bodyBuilder) => {
        emitBody(bodyBuilder);
        terminating = bodyCompletes(child.build());

        if (!terminating) {
          joinedChannels = dedupeDisjointChannels(this.#writeLog.writtenChannelsSince(writeCheckpoint));
          this.#commitJoinedChannels(child, joinedChannels);
        }

        body = child.build();
      });

      assert(body !== undefined, "state-scoped control body was not built");
      return { body, terminating, joinedChannels };
    });
  }

  #commitJoinedChannels(body: BodyBuilder, channels: readonly StateChannel[]): void {
    this.#emitDirtyChannelCommits(body, channels);
  }

  #skippedBody(channels: readonly StateChannel[]): Body | undefined {
    const body = new BodyBuilder(this.#currentBody().values);

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
