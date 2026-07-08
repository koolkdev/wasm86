import {
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  type GprChannel,
  type StateChannel
} from "../../slots.js";

export type StateWriteObserverCheckpoint = Readonly<{
  gprWrites: number;
  stateWrites: number;
  statusFlagSources: number;
}>;

export interface StateWriteObserver {
  recordStateWrite(channel: StateChannel): void;
  recordStatusFlagSourceWrite(): void;
  checkpoint(): StateWriteObserverCheckpoint;
  restore(checkpoint: StateWriteObserverCheckpoint): void;
}

export class StateWriteLog implements StateWriteObserver {
  readonly #gprWrites: GprChannel[] = [];
  readonly #stateWrites: StateChannel[] = [];
  #statusFlagSources = 0;

  recordStateWrite(channel: StateChannel): void {
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

  captureWrittenChannels(build: () => void): readonly StateChannel[] {
    const checkpoint = this.checkpoint();

    build();

    return this.writtenChannelsSince(checkpoint);
  }

  writtenChannelsSince(checkpoint: StateWriteObserverCheckpoint): readonly StateChannel[] {
    return [
      ...this.#gprWrites.slice(checkpoint.gprWrites),
      ...this.#statusFlagWritesSince(checkpoint),
      ...this.#stateWrites.slice(checkpoint.stateWrites)
    ];
  }

  #statusFlagWritesSince(checkpoint: StateWriteObserverCheckpoint): readonly StateChannel[] {
    return this.#statusFlagSources === checkpoint.statusFlagSources
      ? []
      : [lazyFlagsKindChannel, lazyFlagsAChannel, lazyFlagsBChannel];
  }
}
