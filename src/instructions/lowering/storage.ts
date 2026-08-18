import { assert } from "#common/assert.js";
import type { FieldRef } from "#compiler/layout/handles.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import { isX86StatusFlag, type X86Flag } from "#core/flags/definitions.js";
import type { StatusFlagResolverFamily } from "#core/flags/lazy/resolvers.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { BoundStateAccess, StateAccess } from "#core/state/access.js";
import type {
  AccessFault,
  SemanticReadOptions,
  SemanticUpdate,
  SemanticWriteOptions
} from "#instructions/semantics/builder.js";
import { operand, reg } from "#instructions/semantics/refs.js";
import type {
  OperandRef,
  RegRef,
  RegRefForWidth,
  SemanticVar,
  SegmentRef,
  StorageRef
} from "#instructions/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";
import { i32, type Integer, type BitValue, type I32Value } from "#compiler/function/values.js";
import type { MemoryAccess } from "#memory/types.js";
import type { OperandBinding, SegmentOperandBinding } from "./bindings.js";
import { InstructionMemory } from "./memory.js";
import { OperandResolver, type ScopedOperandResolver } from "./operand-resolver.js";
import type { SemanticRegionScope } from "./scope.js";
import { InstructionState } from "./state/state.js";
import type { StateWriteObserver } from "./state/write-log.js";

type WriteSegmentSelector = (
  binding: SegmentOperandBinding,
  value: I32Value,
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

  forScope(
    scope: SemanticRegionScope,
    options: ScopedInstructionStorageOptions
  ): ScopedInstructionStorage {
    const region = scope.region;
    const access = this.#stateAccess.forRegion(region);
    const operands = this.operands.forScope(scope.operands, access);

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

  beginInstruction(
    region: RegionBuilder,
    bindings: readonly OperandBinding[],
    eip: I32Value
  ): void {
    this.operands.beginInstruction(bindings);
    this.state.beginInstruction(this.#stateAccess.forRegion(region), eip);
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

  reg<Name extends RegName>(name: Name): RegRef<Name> {
    return reg(name);
  }

  segment(operandRef: OperandRef): SegmentRef {
    return this.#operands.segment(operandRef.index);
  }

  variable(seed: I32Value): SemanticVar {
    return this.#region.variable(seed);
  }

  address(operandRef: OperandRef): I32Value {
    return this.#operands.address(operandRef.index);
  }

  read(source: SemanticVar): I32Value;
  read<Width extends OperandWidth>(source: RegRefForWidth<Width>): Integer<Width>;
  read<Width extends OperandWidth>(source: SemanticUpdate<Width>): Integer<Width>;
  read<Width extends OperandWidth>(
    source: OperandRef,
    width: Width,
    options?: SemanticReadOptions
  ): Integer<Width>;
  read<Width extends OperandWidth>(
    source: SemanticVar | RegRefForWidth<Width> | SemanticUpdate<Width> | OperandRef,
    width?: Width,
    options?: SemanticReadOptions
  ): Integer<Width> | I32Value {
    switch (source.kind) {
      case "update":
        switch (source.destination.kind) {
          case "memory":
            return this.memory.load(source.destination.access, source.width);
          case "storage":
            return this.#readStorage(source.destination.reference, source.width);
        }
      case "operand": {
        assert(width !== undefined, "operand reads require a width");

        if (this.#operands.isMemory(source.index)) {
          const reference = this.memory.operand(source, options?.addressOffset);
          return this.memory.read(reference, width);
        }

        return this.#readStorage(source, width);
      }
      case "variable":
        return this.#region.read(source);
      case "reg":
        return this.#readStorage(source, source.width);
    }
  }

  write(target: SemanticVar, value: I32Value): void;
  write<Width extends OperandWidth>(
    target: RegRefForWidth<Width>,
    value: Integer<NoInfer<Width>>
  ): void;
  write<Width extends OperandWidth>(
    target: SemanticUpdate<Width>,
    value: Integer<NoInfer<Width>>
  ): void;
  write<Width extends OperandWidth>(
    target: OperandRef,
    value: Integer<Width>,
    options?: SemanticWriteOptions<NoInfer<Width>>
  ): void;
  write<Width extends OperandWidth>(
    target: SemanticVar | RegRefForWidth<Width> | SemanticUpdate<Width> | OperandRef,
    value: Integer<Width>,
    options?: SemanticWriteOptions<NoInfer<Width>>
  ): void {
    switch (target.kind) {
      case "update":
        switch (target.destination.kind) {
          case "memory":
            this.memory.store(target.destination.access, value);
            return;
          case "storage":
            this.#writeStorage(target.destination.reference, value);
            return;
        }
      case "operand": {
        if (!this.#operands.isMemory(target.index)) {
          this.#writeStorage(target, value);
          return;
        }
        const reference = this.memory.operand(target, options?.addressOffset);
        const memoryWidth = options?.memoryWidth;

        if (memoryWidth === undefined) {
          this.memory.write(reference, value);
        } else {
          this.memory.write(reference, value.truncate(memoryWidth));
        }
        return;
      }
      case "variable":
      case "reg":
        this.#writeStorage(target, value);
        return;
    }
  }

  update(target: SemanticVar): SemanticUpdate<32>;
  update<Width extends OperandWidth>(target: RegRefForWidth<Width>): SemanticUpdate<Width>;
  update<Width extends OperandWidth>(
    target: OperandRef,
    width: Width,
    options?: SemanticReadOptions
  ): SemanticUpdate<Width>;
  update<Width extends OperandWidth>(
    target: SemanticVar | RegRefForWidth<Width> | OperandRef,
    width?: Width,
    options?: SemanticReadOptions
  ): SemanticUpdate<Width> | SemanticUpdate<32> {
    switch (target.kind) {
      case "operand": {
        const binding = this.#operands.binding(target.index);

        assert(binding.kind !== "imm", "an immediate operand is not writable");
        assert(width !== undefined, "operand updates require a width");

        if (this.#operands.isMemory(target.index)) {
          const reference = this.memory.operand(target, options?.addressOffset);
          const access = this.memory.guard({
            reference,
            byteLength: i32(width / 8),
            intent: "write"
          });

          return {
            kind: "update",
            width,
            destination: { kind: "memory", access }
          };
        }

        return {
          kind: "update",
          width,
          destination: { kind: "storage", reference: target }
        };
      }
      case "variable":
        return {
          kind: "update",
          width: 32,
          destination: { kind: "storage", reference: target }
        };
      case "reg":
        return {
          kind: "update",
          width: target.width,
          destination: { kind: "storage", reference: target }
        };
    }
  }

  readFlag(flag: X86Flag): BitValue {
    return isX86StatusFlag(flag)
      ? this.#state.statusFlags.read({ region: this.#region, access: this.#access }, flag)
      : this.#state.flags.read(this.#access, flag);
  }

  writeFlag(flag: X86Flag, value: BitValue): void {
    if (isX86StatusFlag(flag)) {
      this.#state.statusFlags.write({ region: this.#region, access: this.#access }, flag, value);
      return;
    }

    this.#state.flags.write(this.#access, flag, value);
  }

  writeStatusFlagsSource<Width extends OperandWidth>(source: SimpleFlagSource<Width>): void {
    this.#state.statusFlags.writeSource({ region: this.#region, access: this.#access }, source);
  }

  condition(cc: ConditionCode): BitValue {
    return this.#state.statusFlags.condition({ region: this.#region, access: this.#access }, cc);
  }

  addInstructionCount(amount: I32Value): void {
    this.#state.instructionCount.add(this.#access, amount);
  }

  #readStorage<Width extends OperandWidth>(storage: StorageRef, width: Width): Integer<Width> {
    switch (storage.kind) {
      case "variable":
        return this.#region.read(storage).truncate(width);
      case "reg":
        return this.#state.gpr.read(this.#access, storage.reg, width);
      case "operand": {
        const binding = this.#operands.binding(storage.index);

        switch (binding.kind) {
          case "imm": {
            const value =
              binding.source.kind === "static" ? i32(binding.source.value) : binding.source.value;

            return value.truncate(width);
          }
          case "reg":
            return binding.selection.kind === "static"
              ? this.#state.gpr.read(this.#access, binding.selection.reg, width)
              : this.#state.gpr.readDynamic(this.#access, binding.selection.index, width);
          case "segment":
            return (
              binding.selection.kind === "static"
                ? this.#state.segments.readSelector(this.#access, binding.selection.reg, width)
                : this.#state.segments.readDynamicSelector(
                    this.#access,
                    binding.selection.index,
                    width
                  )
            ).truncate(width);
          case "mem":
            assert(false, "memory operand reached non-memory read");
        }
      }
    }
  }

  #writeStorage<Width extends OperandWidth>(storage: StorageRef, value: Integer<Width>): void {
    const width = value.width;

    switch (storage.kind) {
      case "variable":
        this.#region.write(storage, value.unsigned.extend(32));
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
            this.#writeSegmentSelector(binding, value.unsigned.extend(32), width);
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
