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
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type { Operation } from "#compiler/ir/operations/index.js";
import type { RegionNode } from "#compiler/ir/region.js";
import { RegionBuilder, type RegionNodeSink } from "#compiler/ir/builder/region.js";
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

// One loop under construction: the carried state, entry-hoisted operations,
// the body's node sink, and the accesses the scope polices.
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
    for (const writeback of this.#scope.exitWritebacks(access, exitValues)) {
      this.#region.operation(resourceWrite, writeback);
    }

    this.#parent.extend(this.#bodySink.entryOperations());
    this.#parent.loop(
      this.#carried.map(({ seed, loopInput }) => ({ seed, loopInput })),
      (body) => body.extend(this.#region.build().nodes)
    );
    this.#scope.close();
  }
}

class LoopBodySink implements RegionNodeSink {
  readonly #scope: StateLoopScope;
  readonly #entryOperations: Operation[] = [];
  readonly #bodyNodes: RegionNode[] = [];

  constructor(scope: StateLoopScope) {
    this.#scope = scope;
  }

  push(node: RegionNode): void {
    if (node.category !== "operation") {
      this.#bodyNodes.push(node);
      return;
    }

    const read = loopInvariantResourceRead(node);

    if (read !== undefined && this.#scope.isExecutionStateEffect(read)) {
      // Dynamic GPR reads flush tracked GPR state - asserted away at their
      // call sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment loads are rejected inside loop
      // bodies and end the block outside them.
      this.#scope.assertHoistableRead(read);
      this.#entryOperations.push(node);
      return;
    }

    this.#bodyNodes.push(node);
  }

  nodes(): readonly RegionNode[] {
    return this.#bodyNodes;
  }

  entryOperations(): readonly Operation[] {
    return this.#entryOperations;
  }
}

// Loop-entry hoisting explicitly recognizes resource reads. A new operation
// cannot become movable merely by declaring the same effect shape.
function loopInvariantResourceRead(operation: Operation): ResourceEffect | undefined {
  if (operation.kind !== resourceRead.kind) {
    return undefined;
  }

  return operation.effect;
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
      guard: (options) => context.host.memory.guard(options),
      resolve: (options) => context.host.memory.resolve(options),
      read: (reference, options) =>
        context.host.memory.read(reference, options),
      write: (reference, options) =>
        context.host.memory.write(reference, options),
      load: (access, options) => context.host.memory.load(access, options),
      store: (access, options) => context.host.memory.store(access, options)
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
