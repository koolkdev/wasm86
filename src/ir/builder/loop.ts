import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#x86/flags.js";
import type {
  GetOptions,
  LoopOptions,
  LoopSemanticsBuilder,
  MemoryAccessKind,
  SemanticOps,
  SimpleFlagSource
} from "#x86/semantics/builder.js";
import {
  toStorageRef,
  type MemRef,
  type OperandInput,
  type OperandRef,
  type RegRef,
  type StorageInput,
  type Value,
  type ValueInput
} from "#x86/semantics/refs.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import { gprChannel, type GprChannel } from "../slots.js";
import type { Action, LoopCarriedCell } from "../actions.js";
import type { OperandBinding } from "../operands.js";
import type { ValueId, ValueTable } from "../values.js";
import type { State } from "./state/index.js";
import { StateLoopScope } from "./state/loop-scope.js";

type LoopCell = Required<LoopCarriedCell>;

export type LoopSemanticsBuilderContext = Readonly<{
  host: SemanticOps;
  state: State;
  scope: StateLoopScope;
  binding(index: number): OperandBinding;
}>;

export type LoopBuilderContext = Readonly<{
  values: ValueTable;
  state: State;
  emitParentAction(action: Action): void;
}>;

// One loop under construction: the carried cells, entry-hoisted actions, the
// body's action sink, and the accesses the scope polices.
export class LoopBuilder {
  readonly #context: LoopBuilderContext;
  readonly #cells: readonly LoopCell[];
  readonly #scope: StateLoopScope;
  readonly #entryActions: Action[] = [];
  readonly #bodyActions: Action[] = [];

  private constructor(
    context: LoopBuilderContext,
    cells: readonly LoopCell[],
    scope: StateLoopScope
  ) {
    this.#context = context;
    this.#cells = cells;
    this.#scope = scope;
  }

  get scope(): StateLoopScope {
    return this.#scope;
  }

  static begin(context: LoopBuilderContext, options: LoopOptions): LoopBuilder {
    const scope = new StateLoopScope(
      context.values,
      context.state,
      options.stateRegs === undefined
        ? { statusFlags: options.statusFlags === true }
        : { regs: options.stateRegs, statusFlags: options.statusFlags === true }
    );

    return new LoopBuilder(context, scope.begin(), scope);
  }

  // The conditional back edge, and the only one. The back edge and the exit
  // tail see the same carried values: one capture serves both.
  emitContinue(condition: ValueInput): readonly ValueId[] {
    const exitValues = this.#scope.captureExitValues();

    this.emitAction({
      kind: "if",
      condition,
      thenBody: { actions: [{ kind: "loopContinue", updates: exitValues }] }
    });

    return exitValues;
  }

  close(enter: ValueInput, exitValues: readonly ValueId[]): void {
    // The exit path's one commit per carried channel.
    for (const action of this.#scope.commitExitValues(exitValues)) {
      this.emitAction(action);
    }

    const loopAction: Action = {
      kind: "loop",
      carried: this.#cells,
      body: { actions: this.#bodyActions }
    };

    // The enter-if is a join: the ran arm commits through the exit tail, the
    // zero-trip arm commits the dirty-at-entry seeds.
    const seedCommits = this.#scope.commitSeedValues();

    this.#context.emitParentAction({
      kind: "if",
      condition: enter,
      thenBody: { actions: [...this.#entryActions, loopAction] },
      ...(seedCommits.length > 0 ? { elseBody: { actions: seedCommits } } : {})
    });

    this.#scope.close();
  }

  // Inside a loop body, reads of channels the loop does not carry are
  // loop-invariant: their ops hoist before the loop and the body consumes
  // the values from locals.
  emitAction(action: Action): void {
    if (action.kind === "op" && action.op.kind === "state.read") {
      const slot = action.op.slot;

      // Dynamic GPR reads flush tracked GPR state - asserted away at their call
      // sites; a dynamic segment base is loop-invariant like any static
      // non-carried channel, since segment writes terminate the block.
      this.#scope.assertHoistableRead(slot);
      this.#entryActions.push(action);
      return;
    }

    if (action.kind === "op" && action.op.kind === "state.write") {
      this.#scope.assertDynamicWriteSupported(action.op.slot);
    }

    this.#bodyActions.push(action);
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

    const channel = this.#writtenGprChannel(target);

    if (channel !== undefined) {
      this.#context.scope.assertWritableChannel(channel);
    }

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
      !isX86StatusFlag(flag) || !this.#context.state.statusFlags.isInputBacked(flag),
      "input-backed status flag reads inside a loop body are unsupported"
    );
    return this.#context.host.readFlag(flag);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    assert(
      this.#context.scope.carriesStatusFlags(),
      "loop body writes status flags, but the loop does not carry them"
    );
    this.#context.host.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    assert(
      !this.#context.state.statusFlags.conditionReadsInputFlags(cc),
      "input-backed conditions inside a loop body are unsupported"
    );
    return this.#context.host.condition(cc);
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

  // The GPR channel a set writes, if any; memory and segment targets have none.
  #writtenGprChannel(storage: StorageInput): GprChannel | undefined {
    const ref = toStorageRef(storage);

    switch (ref.kind) {
      case "reg":
        return gprChannel(ref.reg);
      case "operand": {
        const binding = this.#context.binding(ref.index);

        return binding.kind === "reg" ? binding.channel : undefined;
      }
      case "mem":
        return undefined;
    }
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

  readFlag(flag: X86Flag): Value {
    return this.#state.readFlag(flag);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#state.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    return this.#state.condition(cc);
  }
}
