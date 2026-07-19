import { assert } from "#common/assert.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#core/flags/definitions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type {
  LoopSemanticsBuilder,
  SemanticMemoryOps,
  SemanticOps,
  SemanticReadOptions,
  SemanticUpdate,
  SemanticWriteOptions
} from "#core/semantics/builder.js";
import {
  type OperandInput,
  type OperandRef,
  type RegRef,
  type SegmentRef,
  type StorageInput,
  type Value,
  type ValueInput
} from "#core/semantics/refs.js";
import type { RegName } from "#core/types.js";
import type { CpuException } from "#core/exceptions.js";
import type { IfBody, SemanticBranchHint } from "#core/semantics/builder.js";
import { type InstructionStateChannel } from "./state/channels.js";
import type { ResourceEffect } from "#compiler/ir/resource.js";
import type { Action, OpAction } from "#ir/actions.js";
import { RegionBuilder, type BodyActionSink } from "#ir/region-builder.js";
import type { OperandResolver } from "./operand-resolver.js";
import type { InstructionState } from "./state/state.js";
import {
  StateLoopScope,
  type LoopCarriedState
} from "./state/loop-scope.js";


export type LoopSemanticsBuilderContext = Readonly<{
  host: SemanticOps;
  state: InstructionState;
  operands: OperandResolver;
}>;

export type LoopBuilderContext = Readonly<{
  state: InstructionState;
  parentRegion: RegionBuilder;
}>;

// One loop under construction: the carried state, entry-hoisted actions, the
// body's action sink, and the accesses the scope polices.
export class LoopBuilder {
  readonly #parent: RegionBuilder;
  readonly #state: InstructionState;
  readonly #carried: readonly LoopCarriedState[];
  readonly #scope: StateLoopScope;
  readonly #bodySink: LoopBodySink;
  readonly #region: RegionBuilder;

  private constructor(
    context: LoopBuilderContext,
    carried: readonly LoopCarriedState[],
    scope: StateLoopScope
  ) {
    this.#parent = context.parentRegion;
    this.#state = context.state;
    this.#carried = carried;
    this.#scope = scope;
    this.#bodySink = new LoopBodySink(scope);
    this.#region = context.parentRegion.child(this.#bodySink);
  }

  get region(): RegionBuilder {
    return this.#region;
  }

  static begin(context: LoopBuilderContext, bodyWrites: readonly InstructionStateChannel[]): LoopBuilder {
    const scope = new StateLoopScope(
      context.parentRegion.values,
      context.state,
      bodyWrites
    );

    return new LoopBuilder(
      context,
      scope.begin(context.state.bind(context.parentRegion)),
      scope
    );
  }

  // Close while the semantic loop scope is current: state resolution belongs
  // in the loop body. The back edge and exit tail share one value capture.
  close(condition: ValueInput): void {
    const access = this.#state.bind(this.#region);
    const exitValues = this.#scope.captureExitValues(access);

    this.#region.if(condition, (taken) => taken.loopContinue(exitValues));

    // The exit path's one commit per carried channel.
    for (const action of this.#scope.commitExitValues(access, exitValues)) {
      this.#region.push(action);
    }

    this.#parent.extend(this.#bodySink.entryActions());
    this.#parent.loop(
      this.#carried.map(({ seed, loopInput }) => ({ seed, loopInput })),
      (body) => body.extend(this.#region.build().actions)
    );
    this.#scope.close();
  }
}

class LoopBodySink implements BodyActionSink {
  readonly #scope: StateLoopScope;
  readonly #entryActions: Action[] = [];
  readonly #bodyActions: Action[] = [];

  constructor(scope: StateLoopScope) {
    this.#scope = scope;
  }

  push(action: Action): void {
    if (action.kind !== "op") {
      this.#bodyActions.push(action);
      return;
    }

    const read = loopInvariantResourceRead(action);

    if (read !== undefined && this.#scope.isExecutionStateEffect(read)) {
      // Dynamic GPR reads flush tracked GPR state - asserted away at their
      // call sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment loads are rejected inside loop
      // bodies and end the block outside them.
      this.#scope.assertHoistableRead(read);
      this.#entryActions.push(action);
      return;
    }

    this.#bodyActions.push(action);
  }

  actions(): readonly Action[] {
    return this.#bodyActions;
  }

  entryActions(): readonly Action[] {
    return this.#entryActions;
  }
}

// Loop-entry hoisting deliberately recognizes only a single state read with
// no writes. Keeping that policy named makes new effect shapes opt into this
// transformation explicitly during review.
function loopInvariantResourceRead(action: OpAction): ResourceEffect | undefined {
  const { reads, writes } = action.op.effects;
  const read = reads.length === 1 ? reads[0] : undefined;

  return read?.space === "resource" && writes.length === 0 ? read : undefined;
}

// The loop body's semantic surface: the host's operations behind the scope's
// carried-channel policing and the dynamic-operand guard.
export class LoopSemanticsBuilderImpl implements LoopSemanticsBuilder {
  readonly #context: LoopSemanticsBuilderContext;
  readonly memory: SemanticMemoryOps;

  constructor(context: LoopSemanticsBuilderContext) {
    this.#context = context;
    this.memory = {
      reference: (segment, offset) => context.host.memory.reference(segment, offset),
      operand: (operandRef, addressOffset) => {
        this.#assertOperandSupported(operandRef);
        return context.host.memory.operand(operandRef, addressOffset);
      },
      access: (options) => context.host.memory.access(options),
      resolve: (options) => context.host.memory.resolve(options),
      read: (access, options) => context.host.memory.read(access, options),
      write: (access, options) => context.host.memory.write(access, options)
    };
  }

  operand(index: number): OperandRef {
    return this.#context.host.operand(index);
  }

  reg(regInput: RegName): RegRef {
    return this.#context.host.reg(regInput);
  }

  segment(operandRef: OperandInput): SegmentRef {
    this.#assertOperandSupported(operandRef);
    return this.#context.host.segment(operandRef);
  }

  read(source: StorageInput, options: SemanticReadOptions): Value {
    this.#assertStorageSupported(source);
    return this.#context.host.read(source, options);
  }

  write(target: StorageInput, value: ValueInput, options: SemanticWriteOptions): void {
    this.#assertStorageSupported(target);
    this.#context.host.write(target, value, options);
  }

  update(target: StorageInput, options: SemanticWriteOptions): SemanticUpdate {
    this.#assertStorageSupported(target);
    return this.#context.host.update(target, options);
  }

  address(operandRef: OperandInput): Value {
    this.#assertOperandSupported(operandRef);
    return this.#context.host.address(operandRef);
  }

  readFlag(flag: X86Flag): Value {
    assert(
      !isX86StatusFlag(flag) || !this.#context.state.statusFlags.isInputBacked(flag),
      "input-backed status flag reads inside a loop body are unsupported"
    );
    return this.#context.host.readFlag(flag);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#context.host.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    assert(
      !this.#context.state.statusFlags.conditionReadsInputFlags(cc),
      "input-backed conditions inside a loop body are unsupported"
    );
    return this.#context.host.condition(cc);
  }

  if(
    condition: ValueInput,
    thenBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.#context.host.if(condition, this.#loopIfBody(thenBuild), hint);
  }

  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.#context.host.ifElse(
      condition,
      this.#loopIfBody(thenBuild),
      this.#loopIfBody(elseBuild),
      hint
    );
  }

  cpuException(exception: CpuException<ValueInput>): void {
    this.#context.host.cpuException(exception);
  }

  #loopIfBody(build: IfBody): IfBody {
    return (host, values) => (
      build as IfBody<LoopSemanticsBuilder>
    )(
      new LoopSemanticsBuilderImpl({
        ...this.#context,
        host
      }),
      values
    );
  }

  #assertStorageSupported(storage: StorageInput): void {
    const usesDynamicRegister = storage.kind === "operand" &&
      this.#operandUsesDynamicRegister(storage.index);

    assert(
      !usesDynamicRegister,
      "dynamic register operands inside a loop body are unsupported"
    );
  }

  #assertOperandSupported(operandRef: OperandInput): void {
    assert(
      !this.#operandUsesDynamicRegister(operandRef.index),
      "dynamic register operands inside a loop body are unsupported"
    );
  }

  #operandUsesDynamicRegister(index: number): boolean {
    return this.#context.operands.operandUsesDynamicGpr(index);
  }
}
