import { assert } from "#common/assert.js";
import { isLazyFlagStateField } from "#core/flags/layout.js";
import type {
  IfBody,
  LoopBody,
  SemanticsBuilder
} from "#instructions/semantics/builder.js";
import {
  ifControl,
  type BranchHint
} from "#compiler/ir/controls/index.js";
import { resourceWrite } from "#compiler/ir/operations/resource.js";
import { regionCompletes, type Region } from "#compiler/ir/region.js";
import { RegionBuilder } from "#compiler/ir/builder/region.js";
import { type InstructionStateChannel } from "./state/channels.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { LoopSemanticsBuilderImpl } from "./loop.js";
import type { OperandResolver } from "./operand-resolver.js";
import type {
  SemanticRegionScope,
  SemanticScopeStack
} from "./scope.js";
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
  readonly #bindScope: (scope: SemanticRegionScope) => SemanticsBuilder;
  readonly #operands: OperandResolver;

  constructor(
    state: InstructionState,
    writeLog: StateWriteLog,
    scopes: SemanticScopeStack,
    bindScope: (scope: SemanticRegionScope) => SemanticsBuilder,
    operands: OperandResolver
  ) {
    this.#state = state;
    this.#writeLog = writeLog;
    this.#scopes = scopes;
    this.#bindScope = bindScope;
    this.#operands = operands;
  }

  if(
    parentScope: SemanticRegionScope,
    condition: ValueId,
    emitThen: IfBody,
    hint?: BranchHint
  ): IfOutcome {
    const parent = parentScope.region;
    const conditionValue = parent.values.constValue(condition);

    if (conditionValue !== undefined) {
      if (conditionValue !== 0) {
        emitThen(this.#bindScope(parentScope), parent.values);
      }
      return "continues";
    }

    const thenArm = this.#buildArm(parentScope, emitThen);

    this.#emitOneArmedIf(parentScope, condition, thenArm, hint);
    return "continues";
  }

  ifElse(
    parentScope: SemanticRegionScope,
    condition: ValueId,
    emitThen: IfBody,
    emitElse: IfBody,
    hint?: BranchHint
  ): IfOutcome {
    const parent = parentScope.region;
    const conditionValue = parent.values.constValue(condition);

    if (conditionValue !== undefined) {
      (conditionValue !== 0 ? emitThen : emitElse)(
        this.#bindScope(parentScope),
        parent.values
      );
      return "continues";
    }

    const thenArm = this.#buildArm(parentScope, emitThen);
    const elseArm = this.#buildArm(parentScope, emitElse);

    return this.#emitTwoArmedIf(
      parentScope,
      condition,
      thenArm,
      elseArm,
      hint
    );
  }

  runLoopBody<T>(
    parentScope: SemanticRegionScope,
    region: RegionBuilder,
    body: LoopBody,
    finish: (condition: ValueId) => T
  ): T {
    return this.#scopes.enter(parentScope, "loop", region, (scope) => {
      const loopBuilder = new LoopSemanticsBuilderImpl({
        host: this.#bindScope(scope),
        state: this.#state,
        operands: this.#operands
      });
      const outcome = scope.run(() => body(loopBuilder, region.values));

      assert(outcome.kind === "fallthrough", "a loop body must not terminate the instruction");
      scope.commitMemoryWrites();
      return finish(outcome.result);
    });
  }

  #emitOneArmedIf(
    parentScope: SemanticRegionScope,
    condition: ValueId,
    thenArm: BuiltArm,
    hint?: BranchHint
  ): void {
    const parent = parentScope.region;
    const implicitElse = thenArm.outcome === "completes"
      ? undefined
      : this.#buildImplicitElse(parentScope, thenArm.writtenChannels);

    parent.push(ifControl.create({
      condition,
      ...(hint !== undefined ? { hint } : {}),
      thenBody: thenArm.region.build(),
      ...(implicitElse !== undefined ? { elseBody: implicitElse } : {})
    }));

    if (thenArm.outcome === "continues") {
      this.#applyJoinEffects(
        parentScope,
        [thenArm],
        thenArm.writtenChannels
      );
    }
  }

  #emitTwoArmedIf(
    parentScope: SemanticRegionScope,
    condition: ValueId,
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

    parent.push(ifControl.create({
      condition,
      ...(hint !== undefined ? { hint } : {}),
      thenBody: thenArm.region.build(),
      elseBody: elseArm.region.build()
    }));

    if (continuingArms.length === 0) {
      return "completes";
    }

    this.#applyJoinEffects(parentScope, continuingArms, joinedChannels);
    return "continues";
  }

  #buildArm(
    parentScope: SemanticRegionScope,
    emitBody: IfBody
  ): BuiltArm {
    const writeCheckpoint = this.#writeLog.checkpoint();

    return this.#state.enterScope(() => {
      const child = parentScope.region.child();

      return this.#scopes.enter(parentScope, "arm", child, (scope) => {
        scope.run(() => emitBody(this.#bindScope(scope), child.values));
        const completes = regionCompletes(child.build());

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

  #commitMissingJoinChannels(arm: ContinuingArm, joinedChannels: readonly InstructionStateChannel[]): void {
    const missing = joinedChannels.filter((channel) => (
      arm.writtenChannels.every((written) => !this.#state.sameChannel(written, channel))
    ));

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
    const access = this.#state.bind(region);

    for (const channel of channels) {
      if (this.#state.isChannelDirty(channel)) {
        region.operation(resourceWrite, this.#state.writeback(
          access,
          channel,
          this.#state.readChannel(access, channel)
        ));
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

    if (channels.some(
      (channel) => channel.kind === "field" &&
        isLazyFlagStateField(channel)
    )) {
      // This keeps a later resolver inside an arm from publishing a joined
      // lazy value that has no instruction-start value to restore.
      this.#state.statusFlags.resetToInputs();
    }
  }
}

function armContinues(arm: BuiltArm): arm is ContinuingArm {
  return arm.outcome === "continues";
}
