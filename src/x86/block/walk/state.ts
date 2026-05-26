import { FlagState } from "#x86/block/state/flag-state.js";
import { RegisterState } from "#x86/block/state/register-state.js";

export type BlockProgress = Readonly<{
  opIndex: number;
  phase: "entry" | "before" | "after";
}>;

export type BlockStateInput = Readonly<{
  registers?: RegisterState;
  flags?: FlagState;
  progress?: BlockProgress;
}>;

export class BlockState {
  readonly registers: RegisterState;
  readonly flags: FlagState;
  readonly progress: BlockProgress;

  private constructor(input: Readonly<{
    registers: RegisterState;
    flags: FlagState;
    progress: BlockProgress;
  }>) {
    this.registers = input.registers;
    this.flags = input.flags;
    this.progress = freezeProgress(input.progress);
    Object.freeze(this);
  }

  static initial(input: BlockStateInput = {}): BlockState {
    return new BlockState({
      registers: input.registers ?? RegisterState.initial(),
      flags: input.flags ?? FlagState.initial(),
      progress: input.progress ?? blockProgress(0, "entry")
    });
  }

  static create(input: Readonly<{
    registers: RegisterState;
    flags: FlagState;
    progress: BlockProgress;
  }>): BlockState {
    return new BlockState(input);
  }

  withProgress(progress: BlockProgress): BlockState {
    if (this.progress.opIndex === progress.opIndex && this.progress.phase === progress.phase) {
      return this;
    }

    return new BlockState({
      registers: this.registers,
      flags: this.flags,
      progress
    });
  }

  withRegisters(registers: RegisterState): BlockState {
    if (this.registers === registers) {
      return this;
    }

    return new BlockState({
      registers,
      flags: this.flags,
      progress: this.progress
    });
  }

  withFlags(flags: FlagState): BlockState {
    if (this.flags === flags) {
      return this;
    }

    return new BlockState({
      registers: this.registers,
      flags,
      progress: this.progress
    });
  }
}

export function initialBlockState(input: BlockStateInput = {}): BlockState {
  return BlockState.initial(input);
}

export function blockState(input: Readonly<{
  registers: RegisterState;
  flags: FlagState;
  progress: BlockProgress;
}>): BlockState {
  return BlockState.create(input);
}

export function blockProgress(
  opIndex: number,
  phase: BlockProgress["phase"]
): BlockProgress {
  if (!Number.isInteger(opIndex) || opIndex < 0) {
    throw new Error(`block progress op index must be a non-negative integer: ${opIndex}`);
  }

  return Object.freeze({ opIndex, phase });
}

export function withBlockProgress(
  state: BlockState,
  progress: BlockProgress
): BlockState {
  return state.withProgress(progress);
}

export function withBlockRegisters(
  state: BlockState,
  registers: RegisterState
): BlockState {
  return state.withRegisters(registers);
}

export function withBlockFlags(
  state: BlockState,
  flags: FlagState
): BlockState {
  return state.withFlags(flags);
}

function freezeProgress(progress: BlockProgress): BlockProgress {
  return Object.freeze({
    opIndex: progress.opIndex,
    phase: progress.phase
  });
}
