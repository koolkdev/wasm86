import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#x86/flags.js";
import type {
  GetOptions,
  LoopSemanticsBuilder,
  SemanticOps,
  SimpleFlagSource
} from "#x86/semantics/builder.js";
import {
  toStorageRef,
  type MemRef,
  type MemoryAccess,
  type MemoryAccessKind,
  type OperandInput,
  type OperandRef,
  type RegRef,
  type StorageInput,
  type Value,
  type ValueInput
} from "#x86/semantics/refs.js";
import type { OperandWidth, RegName, SegmentRegister } from "#x86/types.js";
import type { CpuException } from "#x86/exceptions.js";
import type { IfBody, SemanticBranchHint } from "#x86/semantics/builder.js";
import { type StateChannel } from "../slots.js";
import type { Action, LoopCarriedCell } from "../actions.js";
import { BodyBuilder, type BodyActionSink } from "../body-builder.js";
import type { ValueId } from "../values.js";
import { ValueTable } from "../value-table.js";
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
  values: ValueTable;
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
  #exitValues: readonly ValueId[] | undefined;

  private constructor(
    context: LoopBuilderContext,
    cells: readonly LoopCell[],
    scope: StateLoopScope
  ) {
    this.#parent = context.parent;
    this.#cells = cells;
    this.#scope = scope;
    this.#bodySink = new LoopBodySink(scope);
    this.#body = new BodyBuilder(context.values, this.#bodySink);
  }

  get scope(): StateLoopScope {
    return this.#scope;
  }

  get body(): BodyBuilder {
    return this.#body;
  }

  static begin(context: LoopBuilderContext, bodyWrites: readonly StateChannel[]): LoopBuilder {
    const scope = new StateLoopScope(context.values, context.state, bodyWrites);

    return new LoopBuilder(context, scope.begin(), scope);
  }

  // The conditional back edge, and the only one. The back edge and the exit
  // tail see the same carried values: one capture serves both.
  emitContinue(condition: ValueInput): void {
    assert(this.#exitValues === undefined, "the loop back edge is already emitted");

    const exitValues = this.#scope.captureExitValues();

    this.#body.if(condition, (taken) => taken.loopContinue(exitValues));
    this.#exitValues = exitValues;
  }

  close(): void {
    assert(this.#exitValues !== undefined, "cannot close a loop without its back edge");

    // The exit path's one commit per carried channel.
    for (const action of this.#scope.commitExitValues(this.#exitValues)) {
      this.#body.push(action);
    }

    this.#buildBody(this.#parent);
    this.#scope.close();
  }

  #buildBody(body: BodyBuilder): void {
    body.extend(this.#bodySink.entryActions());
    body.loop(this.#cells, (loopBody) => loopBody.extend(this.#body.build().actions));
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
    if (action.kind === "op" && action.op.kind === "state.read") {
      const slot = action.op.slot;

      // Dynamic GPR reads flush tracked GPR state - asserted away at their
      // call sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment loads are rejected inside loop
      // bodies and end the block outside them.
      this.#scope.assertHoistableRead(slot);
      this.#entryActions.push(action);
      return;
    }

    if (action.kind === "op" && action.op.kind === "state.write") {
      this.#scope.assertDynamicWriteSupported(action.op.slot);
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

  memoryResolve<TIntent extends MemoryAccessKind>(
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
