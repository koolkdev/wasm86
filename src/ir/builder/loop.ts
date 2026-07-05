import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { CpuException } from "#x86/exceptions.js";
import { isX86StatusFlag, type X86Flag } from "#x86/flags.js";
import type {
  GetOptions,
  LoopOptions,
  LoopSemanticsBuilder,
  MemoryAccessKind,
  SemanticOps,
  SimpleFlagSource
} from "#x86/semantics/builder.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#x86/semantics/ops.js";
import {
  toStorageRef,
  type MemRef,
  type OperandInput,
  type OperandRef,
  type RegRef,
  type StorageInput,
  type TargetInput,
  type Value,
  type ValueInput
} from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import type { Action, LoopCarriedCell } from "../actions.js";
import type { OperandBinding } from "../operands.js";
import { channelReadBounds } from "../pending/cells.js";
import type { PendingState } from "../pending/state.js";
import {
  channelCovers,
  channelsOverlap,
  gprChannel,
  instructionCountChannel,
  isDynamicSlot,
  lazyFlagsAChannel,
  lazyFlagsBChannel,
  lazyFlagsKindChannel,
  type StateChannel
} from "../slots.js";
import type { StatusFlags } from "../status-flags.js";
import type { ValueId, ValueTable, WidthBounds } from "../values.js";

type LoopCell = Required<LoopCarriedCell>;

export type LoopSemanticsBuilderContext = Readonly<{
  host: SemanticOps;
  values: ValueTable;
  pending: PendingState;
  statusFlags: StatusFlags;
  binding(index: number): OperandBinding;
  resetInstructionCountFold(): void;
}>;

export type LoopBuilderContext = Readonly<{
  values: ValueTable;
  pending: PendingState;
  statusFlags: StatusFlags;
  emitParentAction(action: Action): void;
}>;

// One loop under construction: the carried cells, entry-hoisted actions, the
// body's action sink, and the accesses the scope polices.
export class LoopBuilder {
  readonly #context: LoopBuilderContext;
  readonly #cells: readonly LoopCell[];
  readonly #carried: readonly StateChannel[];
  readonly #statusFlags: boolean;
  readonly #entryActions: Action[] = [];
  readonly #bodyActions: Action[] = [];

  private constructor(
    context: LoopBuilderContext,
    cells: readonly LoopCell[],
    carried: readonly StateChannel[],
    statusFlags: boolean
  ) {
    this.#context = context;
    this.#cells = cells;
    this.#carried = carried;
    this.#statusFlags = statusFlags;
  }

  static begin(context: LoopBuilderContext, options: LoopOptions): LoopBuilder {
    const { pending, values } = context;
    const statusFlags = options.statusFlags === true;
    const carried: StateChannel[] = [
      ...(options.stateRegs ?? []).map((reg) => gprChannel(reg)),
      instructionCountChannel,
      ...(statusFlags ? [lazyFlagsKindChannel, lazyFlagsAChannel, lazyFlagsBChannel] : [])
    ];

    for (const [index, channel] of carried.entries()) {
      assert(
        carried.slice(0, index).every((existing) => !channelsOverlap(existing, channel)),
        "loop state registers must not overlap"
      );
    }

    // Seeds come first: the reads flush and fold pre-loop pendings before
    // the carried cells take over their channels.
    const cells = carried.map((channel) => ({
      channel,
      seed: pending.read(channel),
      loopInput: values.addLoopInput(loopInputBounds(channel))
    }));

    for (const cell of cells) {
      pending.write(cell.channel, cell.loopInput);
    }

    // The iteration top is the fault boundary: carried cells snapshot as
    // their loop inputs, so mid-body faults report iteration-start state.
    pending.beginInstruction();

    return new LoopBuilder(context, cells, carried, statusFlags);
  }

  // The conditional back edge, and the only one. onContinue may update
  // carried values, but those updates apply only to the back edge.
  emitContinue(condition: ValueInput, onContinue: (() => void) | undefined): readonly ValueId[] {
    const { pending } = this.#context;

    const dirty = pending.dirtyChannelsSinceBoundary((channel) => this.#isCarried(channel));

    assert(
      dirty.length === 0,
      `loop body writes undeclared state channel ${JSON.stringify(dirty[0])}`
    );

    const exitValues = this.#cells.map((cell) => pending.read(cell.channel));
    const bodyActionCount = this.#bodyActions.length;

    onContinue?.();

    assert(
      this.#bodyActions.length === bodyActionCount,
      "loop onContinue actions are unsupported; update carried state only"
    );

    const continueUpdates = this.#cells.map((cell) => pending.read(cell.channel));

    this.#cells.forEach((cell, index) => {
      pending.write(cell.channel, exitValues[index]!);
    });

    this.emitAction({
      kind: "if",
      condition,
      thenBody: { actions: [{ kind: "loopContinue", updates: continueUpdates }] }
    });

    return exitValues;
  }

  close(enter: ValueInput, exitValues: readonly ValueId[]): void {
    const { pending, statusFlags } = this.#context;

    assert(
      pending.dirtyChannelsSinceBoundary((channel) => this.#isCarried(channel)).length === 0,
      "loop body state writes after the back edge are unsupported"
    );
    this.#cells.forEach((cell, index) => {
      assert(
        pending.read(cell.channel) === exitValues[index],
        "carried channels must not change after the back edge"
      );
    });

    // The exit path's one commit per carried channel.
    this.#cells.forEach((cell, index) => {
      this.emitAction({ kind: "op", op: { kind: "state.write", slot: cell.channel, value: exitValues[index]! } });
    });

    const loopAction: Action = {
      kind: "loop",
      carried: this.#cells,
      body: { actions: this.#bodyActions }
    };

    this.#context.emitParentAction({
      kind: "if",
      condition: enter,
      thenBody: { actions: [...this.#entryActions, loopAction] }
    });

    // Carried state values live in state memory now.
    for (const cell of this.#cells) {
      pending.invalidate(cell.channel);
    }

    if (this.#statusFlags) {
      statusFlags.resetToInputs();
    }
  }

  // Inside a loop body, reads of channels the loop does not carry are
  // loop-invariant: their ops hoist before the loop and the body consumes
  // the values from locals.
  emitAction(action: Action): void {
    if (action.kind === "op" && action.op.kind === "state.read") {
      const slot = action.op.slot;

      // Dynamic GPR reads flush pendings — asserted away at their call
      // sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment writes terminate the block.
      assert(slot.kind !== "gprDynamic", "dynamic register reads inside a loop body are unsupported");
      assert(
        isDynamicSlot(slot) || !this.#isCarried(slot),
        "carried channels resolve through pending; no state.read may target one inside a loop body"
      );
      this.#entryActions.push(action);
      return;
    }

    if (action.kind === "op" && action.op.kind === "state.write") {
      assert(!isDynamicSlot(action.op.slot), "dynamic state writes inside a loop body are unsupported");
    }

    this.#bodyActions.push(action);
  }

  // Loop bodies may only touch a carried channel whole — a partial overlap
  // would flush the carried cell mid-body.
  onPendingAccess(channel: StateChannel, access: "read" | "write"): void {
    for (const carried of this.#carried) {
      assert(
        !channelsOverlap(carried, channel) ||
          (channelCovers(carried, channel) && channelCovers(channel, carried)),
        `loop body ${access} partially overlaps a carried channel`
      );
    }
  }

  #isCarried(channel: StateChannel): boolean {
    return this.#carried.some((carried) => channelsOverlap(carried, channel));
  }
}

class LoopState {
  readonly #context: LoopSemanticsBuilderContext;

  constructor(context: LoopSemanticsBuilderContext) {
    this.#context = context;
  }

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): Value {
    this.#assertStorageSupported(source);
    return this.#context.host.get(source, accessWidth, options);
  }

  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void {
    this.#assertStorageSupported(target);
    this.#context.host.set(target, value, accessWidth);
  }

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    this.#context.host.memoryGuard(address, byteLength, access);
  }

  address(operandRef: OperandInput): Value {
    this.#assertOperandSupported(operandRef);
    return this.#context.host.address(operandRef);
  }

  linearAddress(operandRef: OperandInput): Value {
    this.#assertOperandSupported(operandRef);
    return this.#context.host.linearAddress(operandRef);
  }

  readFlag(flag: X86Flag): Value {
    assert(
      !isX86StatusFlag(flag) || !this.#context.statusFlags.isInputBacked(flag),
      "input-backed status flag reads inside a loop body are unsupported"
    );
    return this.#context.host.readFlag(flag);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#context.host.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    assert(
      !this.#context.statusFlags.conditionReadsInputFlags(cc),
      "input-backed conditions inside a loop body are unsupported"
    );
    return this.#context.host.condition(cc);
  }

  incrementInstructionCount(): void {
    const { pending, values } = this.#context;

    pending.write(
      instructionCountChannel,
      values.binary("add", pending.read(instructionCountChannel), values.const(1))
    );
    this.#context.resetInstructionCountFold();
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
    const binding = this.#context.binding(index);

    return binding.kind === "regDynamic" || binding.kind === "memDynamic";
  }
}

export class LoopSemanticsBuilderImpl implements LoopSemanticsBuilder {
  readonly #context: LoopSemanticsBuilderContext;
  readonly #state: LoopState;

  constructor(context: LoopSemanticsBuilderContext) {
    this.#context = context;
    this.#state = new LoopState(context);
  }

  operand(index: number): OperandRef {
    return this.#context.host.operand(index);
  }

  const32(value: number): Value {
    return this.#context.host.const32(value);
  }

  const64(value: bigint): Value {
    return this.#context.host.const64(value);
  }

  reg(regInput: RegName): RegRef {
    return this.#context.host.reg(regInput);
  }

  mem(address: ValueInput): MemRef {
    return this.#context.host.mem(address);
  }

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): Value {
    return this.#state.get(source, accessWidth, options);
  }

  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void {
    this.#state.set(target, value, accessWidth);
  }

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    this.#state.memoryGuard(address, byteLength, access);
  }

  address(operandRef: OperandInput): Value {
    return this.#state.address(operandRef);
  }

  linearAddress(operandRef: OperandInput): Value {
    return this.#state.linearAddress(operandRef);
  }

  binary(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    return this.#context.host.binary(operator, a, b);
  }

  unary(operator: UnaryOperator, value: ValueInput): Value {
    return this.#context.host.unary(operator, value);
  }

  select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value {
    return this.#context.host.select(condition, whenTrue, whenFalse);
  }

  truncate(width: OperandWidth, value: ValueInput): Value {
    return this.#context.host.truncate(width, value);
  }

  extend(width: OperandWidth, value: ValueInput, signed: boolean): Value {
    return this.#context.host.extend(width, value, signed);
  }

  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    return this.#context.host.compare(width, operator, a, b);
  }

  binary64(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    return this.#context.host.binary64(operator, a, b);
  }

  compare64(operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    return this.#context.host.compare64(operator, a, b);
  }

  truncate64(width: OperandWidth, value: ValueInput): Value {
    return this.#context.host.truncate64(width, value);
  }

  extend64(width: OperandWidth, value: ValueInput, signed: boolean): Value {
    return this.#context.host.extend64(width, value, signed);
  }

  readFlag(flag: X86Flag): Value {
    return this.#state.readFlag(flag);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#state.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    return this.#state.condition(cc);
  }

  incrementInstructionCount(): void {
    this.#state.incrementInstructionCount();
  }

  currentEip(): Value {
    return unsupportedLoopOperation("currentEip");
  }

  nextEip(): Value {
    return unsupportedLoopOperation("nextEip");
  }

  writeFlag(_flag: X86Flag, _value: ValueInput): void {
    unsupportedLoopOperation("writeFlag");
  }

  next(): void {
    unsupportedLoopOperation("next");
  }

  jump(_target: TargetInput): void {
    unsupportedLoopOperation("jump");
  }

  jumpIf(_condition: ValueInput, _target: TargetInput): void {
    unsupportedLoopOperation("jumpIf");
  }

  loop(_options: LoopOptions): void {
    unsupportedLoopOperation("loop");
  }

  cpuExceptionIf(_condition: ValueInput, _exception: CpuException<ValueInput>): void {
    unsupportedLoopOperation("cpuExceptionIf");
  }

  hostTrap(_vector: ValueInput): void {
    unsupportedLoopOperation("hostTrap");
  }

  hostTrapIf(_condition: ValueInput, _vector: ValueInput): void {
    unsupportedLoopOperation("hostTrapIf");
  }
}

// A loop input is exactly as wide as a read of its channel.
function loopInputBounds(channel: StateChannel): WidthBounds | undefined {
  return channel.kind === "gpr" ? undefined : channelReadBounds(channel);
}

function unsupportedLoopOperation(op: string): never {
  assert(false, `${op} inside a loop body is unsupported`);
}
