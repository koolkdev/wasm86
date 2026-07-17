import { assert } from "#common/assert.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#core/flags/definitions.js";
import type {
  GetOptions,
  LoopSemanticsBuilder,
  SemanticOps,
  SimpleFlagSource
} from "#core/semantics/builder.js";
import {
  toStorageRef,
  type MemRef,
  type OperandInput,
  type OperandRef,
  type RegRef,
  type StorageInput,
  type Value,
  type ValueInput
} from "#core/semantics/refs.js";
import type {
  MemoryAccess,
  MemoryDataAccessIntent
} from "#memory/access.js";
import type { OperandWidth, RegName, SegmentRegister } from "#core/types.js";
import type { CpuException } from "#core/exceptions.js";
import type { IfBody, SemanticBranchHint } from "#core/semantics/builder.js";
import { type StateChannel, type StateSlot } from "../slots.js";
import type { Action, LoopCarriedCell, OpAction } from "../actions.js";
import { BodyBuilder, type BodyActionSink } from "../body-builder.js";
import type { OperandResolver } from "./operands.js";
import type { State } from "./state/index.js";
import { StateLoopScope } from "./state/loop-scope.js";

type LoopCell = Required<LoopCarriedCell>;

export type LoopSemanticsBuilderContext = Readonly<{
  host: SemanticOps;
  memory: LoopMemoryOps;
  state: State;
  operands: OperandResolver;
}>;

export type LoopMemoryOps = Pick<SemanticOps, "memoryRead" | "memoryWrite">;

export type LoopBuilderContext = Readonly<{
  state: State;
  parent: BodyBuilder;
}>;

// One loop under construction: the carried cells, entry-hoisted actions, the
// body's action sink, and the accesses the scope polices.
export class LoopBuilder {
  readonly #parent: BodyBuilder;
  readonly #cells: readonly LoopCell[];
  readonly #scope: StateLoopScope;
  readonly #bodySink: LoopBodySink;
  readonly #body: BodyBuilder;

  private constructor(
    context: LoopBuilderContext,
    cells: readonly LoopCell[],
    scope: StateLoopScope
  ) {
    this.#parent = context.parent;
    this.#cells = cells;
    this.#scope = scope;
    this.#bodySink = new LoopBodySink(scope);
    this.#body = context.parent.child(this.#bodySink);
  }

  get body(): BodyBuilder {
    return this.#body;
  }

  static begin(context: LoopBuilderContext, bodyWrites: readonly StateChannel[]): LoopBuilder {
    const scope = new StateLoopScope(context.parent.values, context.state, bodyWrites);

    return new LoopBuilder(context, scope.begin(), scope);
  }

  // Close while the semantic loop scope is current: state resolution belongs
  // in the loop body. The back edge and exit tail share one value capture.
  close(condition: ValueInput): void {
    const exitValues = this.#scope.captureExitValues();

    this.#body.if(condition, (taken) => taken.loopContinue(exitValues));

    // The exit path's one commit per carried channel.
    for (const action of this.#scope.commitExitValues(exitValues)) {
      this.#body.push(action);
    }

    this.#parent.extend(this.#bodySink.entryActions());
    this.#parent.loop(
      this.#cells,
      (body) => body.extend(this.#body.build().actions)
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

    const read = loopInvariantStateRead(action);

    if (read !== undefined) {
      // Dynamic GPR reads flush tracked GPR state - asserted away at their
      // call sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment loads are rejected inside loop
      // bodies and end the block outside them.
      this.#scope.assertHoistableRead(read);
      this.#entryActions.push(action);
      return;
    }

    for (const write of action.op.effects.writes) {
      if (write.space === "state") {
        this.#scope.assertDynamicWriteSupported(write.slot);
      }
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
function loopInvariantStateRead(action: OpAction): StateSlot | undefined {
  const { reads, writes } = action.op.effects;
  const read = reads.length === 1 ? reads[0] : undefined;

  return read?.space === "state" && writes.length === 0 ? read.slot : undefined;
}

// The loop body's semantic surface: the host's operations behind the scope's
// carried-channel policing and the dynamic-operand guard.
export class LoopSemanticsBuilderImpl implements LoopSemanticsBuilder {
  readonly #context: LoopSemanticsBuilderContext;

  constructor(context: LoopSemanticsBuilderContext) {
    this.#context = context;
  }

  operand(index: number): OperandRef {
    return this.#context.host.operand(index);
  }

  reg(regInput: RegName): RegRef {
    return this.#context.host.reg(regInput);
  }

  mem(segment: SegmentRegister, offset: ValueInput): MemRef {
    return this.#context.host.mem(segment, offset);
  }

  operandMem(operandRef: OperandInput, displacement?: ValueInput): MemRef {
    this.#assertOperandSupported(operandRef);
    return this.#context.host.operandMem(operandRef, displacement);
  }

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): Value {
    this.#assertStorageSupported(source);
    return this.#context.host.get(source, accessWidth, options);
  }

  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void {
    this.#assertStorageSupported(target);
    this.#context.host.set(target, value, accessWidth);
  }

  memoryResolve<TIntent extends MemoryDataAccessIntent>(
    memory: MemRef,
    byteLength: ValueInput,
    intent: TIntent
  ): MemoryAccess<TIntent> {
    return this.#context.host.memoryResolve(memory, byteLength, intent);
  }

  memoryRead(
    access: MemoryAccess,
    byteOffset: ValueInput,
    width: OperandWidth,
    options?: GetOptions
  ): Value {
    return this.#context.memory.memoryRead(access, byteOffset, width, options);
  }

  memoryWrite(
    access: MemoryAccess<"write">,
    byteOffset: ValueInput,
    value: ValueInput,
    width: OperandWidth
  ): void {
    this.#context.memory.memoryWrite(access, byteOffset, value, width);
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
    return (_host, values) => (
      build as IfBody<LoopSemanticsBuilder>
    )(this, values);
  }

  #assertStorageSupported(storage: StorageInput): void {
    const ref = toStorageRef(storage);
    const usesDynamicRegister = ref.kind === "operand" && this.#operandUsesDynamicRegister(ref.index);

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
