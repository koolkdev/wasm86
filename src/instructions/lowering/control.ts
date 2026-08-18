import { assert } from "#common/assert.js";
import { isLazyFlagStateField } from "#core/flags/layout.js";
import type { IfBody, LoopBody, SemanticsBuilder } from "#instructions/semantics/builder.js";
import type { BranchHint } from "#compiler/function/control.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type { Region } from "#compiler/function/region.js";
import { type InstructionStateChannel } from "./state/channels.js";
import type { BitValue } from "#compiler/function/values.js";
import type { SemanticRegionScope, SemanticScopeStack } from "./scope.js";
import type { InstructionState } from "./state/state.js";
import type { StateWriteLog } from "./state/write-log.js";

export type IfOutcome = "continues" | "completes";

type CompletingArm = Readonly<{
  region: RegionBuilder;
  outcome: "completes";
}>;

type ContinuingArm = Readonly<{
  region: RegionBuilder;
  outcome: "continues";
  writtenChannels: readonly InstructionStateChannel[];
  memoryMayBeWritten: boolean;
}>;

type BuiltArm = CompletingArm | ContinuingArm;

export class ControlEmitter {
  readonly #state: InstructionState;
  readonly #writeLog: StateWriteLog;
  readonly #scopes: SemanticScopeStack;
  readonly #semanticsBuilderForScope: (scope: SemanticRegionScope) => SemanticsBuilder;

  constructor(
    state: InstructionState,
    writeLog: StateWriteLog,
    scopes: SemanticScopeStack,
    semanticsBuilderForScope: (scope: SemanticRegionScope) => SemanticsBuilder
  ) {
    this.#state = state;
    this.#writeLog = writeLog;
    this.#scopes = scopes;
    this.#semanticsBuilderForScope = semanticsBuilderForScope;
  }

  if(
    parentScope: SemanticRegionScope,
    condition: BitValue,
    emitThen: IfBody,
    hint?: BranchHint
  ): IfOutcome {
    const parent = parentScope.region;
    const conditionValue = parent.constValue(condition);

    if (conditionValue !== undefined) {
      if (conditionValue !== 0) {
        emitThen(this.#semanticsBuilderForScope(parentScope));
      }
      return "continues";
    }

    const thenArm = this.#buildArm(parentScope, emitThen);

    this.#emitOneArmedIf(parentScope, condition, thenArm, hint);
    return "continues";
  }

  ifElse(
    parentScope: SemanticRegionScope,
    condition: BitValue,
    emitThen: IfBody,
    emitElse: IfBody,
    hint?: BranchHint
  ): IfOutcome {
    const parent = parentScope.region;
    const conditionValue = parent.constValue(condition);

    if (conditionValue !== undefined) {
      (conditionValue !== 0 ? emitThen : emitElse)(this.#semanticsBuilderForScope(parentScope));
      return "continues";
    }

    const thenArm = this.#buildArm(parentScope, emitThen);
    const elseArm = this.#buildArm(parentScope, emitElse);

    return this.#emitTwoArmedIf(parentScope, condition, thenArm, elseArm, hint);
  }

  runLoopBody<T>(
    parentScope: SemanticRegionScope,
    region: RegionBuilder,
    body: LoopBody,
    finish: (condition: BitValue) => T
  ): T {
    return this.#scopes.enter(parentScope, "loop", region, (scope) => {
      const outcome = scope.run(() => body(this.#semanticsBuilderForScope(scope)));

      assert(outcome.kind === "fallthrough", "a loop body must not terminate the instruction");
      scope.commitMemoryWrites();
      return finish(outcome.result);
    });
  }

  #emitOneArmedIf(
    parentScope: SemanticRegionScope,
    condition: BitValue,
    thenArm: BuiltArm,
    hint?: BranchHint
  ): void {
    const parent = parentScope.region;
    const implicitElse =
      thenArm.outcome === "completes"
        ? undefined
        : this.#buildImplicitElse(parentScope, thenArm.writtenChannels);

    parent.ifControl(condition, {
      ...(hint !== undefined ? { hint } : {}),
      thenBody: thenArm.region.build(),
      ...(implicitElse !== undefined ? { elseBody: implicitElse } : {})
    });

    if (thenArm.outcome === "continues") {
      this.#applyJoinEffects(parentScope, [thenArm], thenArm.writtenChannels);
    }
  }

  #emitTwoArmedIf(
    parentScope: SemanticRegionScope,
    condition: BitValue,
    thenArm: BuiltArm,
    elseArm: BuiltArm,
    hint?: BranchHint
  ): IfOutcome {
    const parent = parentScope.region;
    const continuingArms = [thenArm, elseArm].filter(armContinues);
    const joinedChannels = this.#state.dedupeDisjointChannels(
      continuingArms.flatMap((arm) => arm.writtenChannels)
    );

    for (const arm of continuingArms) {
      this.#commitMissingJoinChannels(arm, joinedChannels);
    }

    parent.ifControl(condition, {
      ...(hint !== undefined ? { hint } : {}),
      thenBody: thenArm.region.build(),
      elseBody: elseArm.region.build()
    });

    if (continuingArms.length === 0) {
      return "completes";
    }

    this.#applyJoinEffects(parentScope, continuingArms, joinedChannels);
    return "continues";
  }

  #buildArm(parentScope: SemanticRegionScope, emitBody: IfBody): BuiltArm {
    const writeCheckpoint = this.#writeLog.checkpoint();

    return this.#state.enterScope(() => {
      const child = parentScope.region.child();

      return this.#scopes.enter(parentScope, "arm", child, (scope) => {
        scope.run(() => emitBody(this.#semanticsBuilderForScope(scope)));
        const completes = !child.build().fallsThrough;

        if (completes) {
          return { region: child, outcome: "completes" };
        }

        const writtenChannels = this.#state.dedupeDisjointChannels(
          this.#writeLog.writtenChannelsSince(writeCheckpoint)
        );

        this.#flushDirtyChannelsInto(child, writtenChannels);
        return {
          region: child,
          outcome: "continues",
          writtenChannels,
          memoryMayBeWritten: scope.wroteMemory()
        };
      });
    });
  }

  #commitMissingJoinChannels(
    arm: ContinuingArm,
    joinedChannels: readonly InstructionStateChannel[]
  ): void {
    const missing = joinedChannels.filter((channel) =>
      arm.writtenChannels.every((written) => !this.#state.sameChannel(written, channel))
    );

    this.#flushDirtyChannelsInto(arm.region, missing);
  }

  #buildImplicitElse(
    parentScope: SemanticRegionScope,
    channels: readonly InstructionStateChannel[]
  ): Region | undefined {
    const region = parentScope.region.child();

    if (!this.#flushDirtyChannelsInto(region, channels)) {
      return undefined;
    }

    return region.build();
  }

  #flushDirtyChannelsInto(
    region: RegionBuilder,
    channels: readonly InstructionStateChannel[]
  ): boolean {
    let emitted = false;
    const access = this.#state.forRegion(region);

    for (const channel of channels) {
      if (this.#state.isChannelDirty(channel)) {
        const value = this.#state.readChannel(access, channel);
        const writeback = this.#state.writeback(access, channel, value);

        writeback.emit(region);
        emitted = true;
      }
    }

    return emitted;
  }

  #applyJoinEffects(
    parentScope: SemanticRegionScope,
    arms: readonly ContinuingArm[],
    joinedChannels: readonly InstructionStateChannel[]
  ): void {
    if (arms.some((arm) => arm.memoryMayBeWritten)) {
      parentScope.recordMemoryWrite();
    }

    this.#invalidateJoinChannels(joinedChannels);
  }

  #invalidateJoinChannels(channels: readonly InstructionStateChannel[]): void {
    for (const channel of channels) {
      this.#state.invalidate(channel);
      this.#writeLog.recordStateWrite(channel);
    }

    if (channels.some((channel) => channel.kind === "field" && isLazyFlagStateField(channel))) {
      // This keeps a later resolver inside an arm from publishing a joined
      // lazy value that has no instruction-start value to restore.
      this.#state.statusFlags.resetToInputs();
    }
  }
}

function armContinues(arm: BuiltArm): arm is ContinuingArm {
  return arm.outcome === "continues";
}
