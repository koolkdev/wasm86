import { assert } from "#common/assert.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#core/flags/definitions.js";
import type { StatusFlagResolverFamily } from "#core/flags/lazy/resolvers.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { BoundStateAccess, StateAccess } from "#core/state/access.js";
import type {
  AccessFault,
  SemanticReadOptions,
  SemanticUpdate,
  SemanticVar,
  SemanticWriteOptions
} from "#instructions/semantics/builder.js";
import { operand, reg } from "#instructions/semantics/refs.js";
import type {
  OperandInput,
  OperandRef,
  RegRef,
  SegmentRef,
  StorageInput,
  Value,
  ValueInput
} from "#instructions/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { MemoryAccess } from "#memory/types.js";
import type { OperandBinding, SegmentOperandBinding } from "./bindings.js";
import { InstructionMemory } from "./memory.js";
import { OperandResolver, type ScopedOperandResolver } from "./operand-resolver.js";
import type { SemanticRegionScope } from "./scope.js";
import { InstructionState } from "./state/state.js";
import type { StateWriteObserver } from "./state/write-log.js";

type WriteSegmentSelector = (
  binding: SegmentOperandBinding,
  value: ValueInput,
  width: OperandWidth
) => void;

type InstructionStorageOptions = Readonly<{
  stateAccess: StateAccess;
  statusFlagResolvers: StatusFlagResolverFamily;
  memory: MemoryAccess;
  instructionCountField: FieldRef<"u32">;
  writeObserver: StateWriteObserver;
}>;

type ScopedInstructionStorageOptions = Readonly<{
  raiseAccessFault(fault: AccessFault): void;
  writeSegmentSelector: WriteSegmentSelector;
}>;

// One instruction transaction owns pending/restart state and decoded operand
// bindings. A lexical scope binds that shared transaction to one exact region;
// no operation sink is selected through an ambient cursor.
export class InstructionStorage {
  readonly #stateAccess: StateAccess;
  readonly #memory: MemoryAccess;

  readonly state: InstructionState;
  readonly operands: OperandResolver;

  constructor(options: InstructionStorageOptions) {
    this.#stateAccess = options.stateAccess;
    this.#memory = options.memory;
    this.state = new InstructionState(
      options.stateAccess,
      options.statusFlagResolvers,
      options.instructionCountField,
      options.writeObserver
    );
    this.operands = new OperandResolver(this.state);
  }

  bind(
    scope: SemanticRegionScope,
    options: ScopedInstructionStorageOptions
  ): ScopedInstructionStorage {
    const region = scope.region;
    const access = this.#stateAccess.bind(region);
    const operands = this.operands.bind(scope.operands, access);

    return new ScopedInstructionStorage(
      region,
      access,
      this.state,
      operands,
      new InstructionMemory(region, this.#memory, operands, {
        raiseFault: options.raiseAccessFault,
        recordWrite: () => scope.recordMemoryWrite()
      }),
      options
    );
  }

  beginInstruction(bindings: readonly OperandBinding[], eip: ValueInput): void {
    this.operands.beginInstruction(bindings);
    this.state.beginInstruction(eip);
  }

  endInstruction(): void {
    this.operands.endInstruction();
  }

  currentBindings(): readonly OperandBinding[] {
    return this.operands.currentBindings();
  }
}

// Instruction-facing storage fixed to one lexical RegionBuilder. Resolved
// memory accesses may come from an ancestor; only the consuming operation is
// bound here.
export class ScopedInstructionStorage {
  readonly #region: RegionBuilder;
  readonly #access: BoundStateAccess;
  readonly #state: InstructionState;
  readonly #operands: ScopedOperandResolver;
  readonly #writeSegmentSelector: WriteSegmentSelector;

  readonly memory: InstructionMemory;

  constructor(
    region: RegionBuilder,
    access: BoundStateAccess,
    state: InstructionState,
    operands: ScopedOperandResolver,
    memory: InstructionMemory,
    options: ScopedInstructionStorageOptions
  ) {
    this.#region = region;
    this.#access = access;
    this.#state = state;
    this.#operands = operands;
    this.memory = memory;
    this.#writeSegmentSelector = options.writeSegmentSelector;
  }

  get region(): RegionBuilder {
    return this.#region;
  }

  get access(): BoundStateAccess {
    return this.#access;
  }

  operand(index: number): OperandRef {
    this.#operands.binding(index);
    return operand(index);
  }

  reg(name: RegName): RegRef {
    return reg(name);
  }

  segment(operandRef: OperandInput): SegmentRef {
    return this.#operands.segment(operandRef.index);
  }

  variable(seed: ValueInput): SemanticVar {
    assert(this.#region.values.valueType(seed) === "i32", "semantic var seed must be i32");
    return this.#region.variable(seed) as SemanticVar;
  }

  address(operandRef: OperandRef): Value {
    return this.#operands.address(operandRef.index);
  }

  read(source: StorageInput, options: SemanticReadOptions): Value {
    const signed = options.signed ?? false;

    if (source.kind === "operand" && this.#operands.isMemory(source.index)) {
      const width = options.memory?.width ?? options.width;
      const reference = this.memory.operand(source, options.memory?.addressOffset?.());
      return this.memory.read(reference, { width, signed });
    }

    return this.#readStorage(source, options.width, signed);
  }

  write(target: StorageInput, value: ValueInput, options: SemanticWriteOptions): void {
    if (target.kind === "operand" && this.#operands.isMemory(target.index)) {
      const width = options.memory?.width ?? options.width;
      const reference = this.memory.operand(target, options.memory?.addressOffset?.());
      this.memory.write(reference, { width, value });
      return;
    }

    this.#writeStorage(target, value, options.width);
  }

  update(target: StorageInput, options: SemanticWriteOptions): SemanticUpdate {
    if (target.kind === "operand") {
      const binding = this.#operands.binding(target.index);

      assert(binding.kind !== "imm", "an immediate operand is not writable");
    }

    if (target.kind === "operand" && this.#operands.isMemory(target.index)) {
      const width = options.memory?.width ?? options.width;
      const reference = this.memory.operand(target, options.memory?.addressOffset?.());
      const access = this.memory.guard({
        reference,
        byteLength: this.#region.values.const(width / 8),
        intent: "write"
      });

      return {
        read: (region) => region.memory.load(access, { width }),
        write: (region, value) => region.memory.store(access, { width, value })
      };
    }

    return {
      read: (region) =>
        region.read(target, {
          width: options.width
        }),
      write: (region, value) =>
        region.write(target, value, {
          width: options.width
        })
    };
  }

  readFlag(flag: X86Flag): Value {
    return isX86StatusFlag(flag)
      ? this.#state.statusFlags.read({ region: this.#region, access: this.#access }, flag)
      : this.#state.flags.read(this.#access, flag);
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    if (isX86StatusFlag(flag)) {
      this.#state.statusFlags.write({ region: this.#region, access: this.#access }, flag, value);
      return;
    }

    this.#state.flags.write(flag, value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#state.statusFlags.writeSource({ region: this.#region, access: this.#access }, source);
  }

  condition(cc: ConditionCode): Value {
    return this.#state.statusFlags.condition({ region: this.#region, access: this.#access }, cc);
  }

  addInstructionCount(amount: ValueInput): void {
    this.#state.instructionCount.add(this.#access, amount);
  }

  #readStorage(storage: StorageInput, width: OperandWidth, signed: boolean): Value {
    const options = signed ? ({ signed: true } as const) : {};

    switch (storage.kind) {
      case "variable":
        return this.#region.read(storage);
      case "reg":
        return this.#state.gpr.read(this.#access, storage.reg, width, options);
      case "operand": {
        const binding = this.#operands.binding(storage.index);

        switch (binding.kind) {
          case "imm": {
            const value =
              binding.source.kind === "static"
                ? this.#region.values.const(binding.source.value)
                : binding.source.value;

            return this.#region.values.widthAdjusted(width, value, signed);
          }
          case "reg":
            return binding.selection.kind === "static"
              ? this.#state.gpr.read(this.#access, binding.selection.reg, width, options)
              : this.#state.gpr.readDynamic(this.#access, binding.selection.index, width, options);
          case "segment":
            return binding.selection.kind === "static"
              ? this.#state.segments.readSelector(
                  this.#access,
                  binding.selection.reg,
                  width,
                  options
                )
              : this.#state.segments.readDynamicSelector(
                  this.#access,
                  binding.selection.index,
                  width,
                  options
                );
          case "mem":
            assert(false, "memory operand reached non-memory read");
        }
      }
    }
  }

  #writeStorage(storage: StorageInput, value: ValueInput, width: OperandWidth): void {
    switch (storage.kind) {
      case "variable":
        this.#region.write(storage, value);
        return;
      case "reg":
        this.#state.gpr.write(this.#access, storage.reg, value, width);
        return;
      case "operand": {
        const binding = this.#operands.binding(storage.index);

        switch (binding.kind) {
          case "reg":
            if (binding.selection.kind === "static") {
              this.#state.gpr.write(this.#access, binding.selection.reg, value, width);
              return;
            }
            this.#state.gpr.writeDynamic(this.#access, binding.selection.index, width, value);
            return;
          case "segment":
            this.#writeSegmentSelector(binding, value, width);
            return;
          case "imm":
            assert(false, "an immediate operand is not writable");
          case "mem":
            assert(false, "memory operand reached non-memory write");
        }
      }
    }
  }
}
