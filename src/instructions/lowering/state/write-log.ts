import { flagStateFields } from "#core/flags/layout.js";
import type { GprChannel } from "#core/state/channels.js";
import type { InstructionStateChannel } from "./channels.js";

export type StateWriteObserverCheckpoint = Readonly<{
  gprWrites: number;
  stateWrites: number;
  statusFlagSources: number;
}>;

export interface StateWriteObserver {
  recordStateWrite(channel: InstructionStateChannel): void;
  recordStatusFlagSourceWrite(): void;
  checkpoint(): StateWriteObserverCheckpoint;
  restore(checkpoint: StateWriteObserverCheckpoint): void;
}

export class StateWriteLog implements StateWriteObserver {
  readonly #gprWrites: GprChannel[] = [];
  readonly #stateWrites: InstructionStateChannel[] = [];
  #statusFlagSources = 0;

  recordStateWrite(channel: InstructionStateChannel): void {
    if (channel.kind === "gpr") {
      this.#gprWrites.push(channel);
      return;
    }

    this.#stateWrites.push(channel);
  }

  recordStatusFlagSourceWrite(): void {
    this.#statusFlagSources++;
  }

  checkpoint(): StateWriteObserverCheckpoint {
    return {
      gprWrites: this.#gprWrites.length,
      stateWrites: this.#stateWrites.length,
      statusFlagSources: this.#statusFlagSources
    };
  }

  restore(checkpoint: StateWriteObserverCheckpoint): void {
    this.#gprWrites.length = checkpoint.gprWrites;
    this.#stateWrites.length = checkpoint.stateWrites;
    this.#statusFlagSources = checkpoint.statusFlagSources;
  }

  captureWrittenChannels(build: () => void): readonly InstructionStateChannel[] {
    const checkpoint = this.checkpoint();

    build();

    return this.writtenChannelsSince(checkpoint);
  }

  writtenChannelsSince(
    checkpoint: StateWriteObserverCheckpoint
  ): readonly InstructionStateChannel[] {
    return [
      ...this.#gprWrites.slice(checkpoint.gprWrites),
      ...this.#statusFlagWritesSince(checkpoint),
      ...this.#stateWrites.slice(checkpoint.stateWrites)
    ];
  }

  #statusFlagWritesSince(
    checkpoint: StateWriteObserverCheckpoint
  ): readonly InstructionStateChannel[] {
    return this.#statusFlagSources === checkpoint.statusFlagSources
      ? []
      : [flagStateFields.lazyKind, flagStateFields.lazyA, flagStateFields.lazyB];
  }
}
