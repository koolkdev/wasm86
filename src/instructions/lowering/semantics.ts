import { assert } from "#common/assert.js";
import type { CpuException } from "#core/exceptions.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#core/flags/definitions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type {
  IfBody,
  LoopBody,
  SemanticBranchHint,
  SemanticMemoryOps,
  SemanticReadOptions,
  SemanticsBuilder,
  SemanticUpdate,
  SemanticWriteOptions
} from "#instructions/semantics/builder.js";
import type {
  OperandRef,
  RegRef,
  RegRefForWidth,
  SemanticVar,
  SegmentRef,
  StorageRef
} from "#instructions/semantics/refs.js";
import type { OperandWidth, RegName } from "#core/types.js";
import type { OperandResolver } from "./operand-resolver.js";
import type { SemanticRegionScope } from "./scope.js";
import type { InstructionState } from "./state/state.js";
import type { ScopedInstructionStorage } from "./storage.js";
import type { Integer, BitValue, I32Value } from "#compiler/function/values.js";

// Lifecycle operations supplied by the instruction session. The semantic
// facade fixes these operations and storage to one lexical scope.
export interface InstructionSemanticsSession {
  assertActive(scope: SemanticRegionScope): void;
  currentEip(): I32Value;
  nextEip(): I32Value;
  jump(scope: SemanticRegionScope, target: I32Value): void;
  if(
    scope: SemanticRegionScope,
    condition: BitValue,
    thenBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  ifElse(
    scope: SemanticRegionScope,
    condition: BitValue,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  loop(scope: SemanticRegionScope, body: LoopBody): void;
  cpuException(scope: SemanticRegionScope, exception: CpuException<I32Value>): void;
  hostTrap(scope: SemanticRegionScope, vector: Integer<8>): void;
}

// The x86 semantic language projected onto one lexical region. These objects
// are cheap facades over the session's shared transaction state.
export class ScopedSemanticsBuilder implements SemanticsBuilder {
  readonly #session: InstructionSemanticsSession;
  readonly #scope: SemanticRegionScope;
  readonly #storage: ScopedInstructionStorage;
  readonly #state: InstructionState;
  readonly #operands: OperandResolver;
  readonly memory: SemanticMemoryOps;

  constructor(
    context: Readonly<{
      session: InstructionSemanticsSession;
      scope: SemanticRegionScope;
      storage: ScopedInstructionStorage;
      state: InstructionState;
      operands: OperandResolver;
    }>
  ) {
    this.#session = context.session;
    this.#scope = context.scope;
    this.#storage = context.storage;
    this.#state = context.state;
    this.#operands = context.operands;
    this.memory = {
      reference: (segment, offset) => this.#active().memory.reference(segment, offset),
      operand: (operandRef, addressOffset) => {
        this.#assertOperandSupported(operandRef);
        return this.#active().memory.operand(operandRef, addressOffset);
      },
      guard: (options) => this.#active().memory.guard(options),
      resolve: (options) => this.#active().memory.resolve(options),
      read: (reference, width) => this.#active().memory.read(reference, width),
      write: (reference, value) => this.#active().memory.write(reference, value),
      load: (access, width, byteOffset) => this.#active().memory.load(access, width, byteOffset),
      store: (access, value, byteOffset) => this.#active().memory.store(access, value, byteOffset)
    };
  }

  operand(index: number): OperandRef {
    return this.#active().operand(index);
  }

  currentEip(): I32Value {
    this.#active();
    return this.#session.currentEip();
  }

  nextEip(): I32Value {
    this.#active();
    return this.#session.nextEip();
  }

  segment(operandRef: OperandRef): SegmentRef {
    this.#assertOperandSupported(operandRef);
    return this.#active().segment(operandRef);
  }

  reg<Name extends RegName>(regInput: Name): RegRef<Name> {
    return this.#active().reg(regInput);
  }

  var(seed: I32Value): SemanticVar {
    return this.#active().variable(seed);
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
        this.#assertUpdateSupported(source);
        return this.#active().read(source);
      case "operand":
        this.#assertStorageSupported(source);
        assert(width !== undefined, "operand reads require a width");
        return this.#active().read(source, width, options);
      case "variable":
        return this.#active().read(source);
      case "reg":
        return this.#active().read(source);
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
        this.#assertUpdateSupported(target);
        this.#active().write(target, value);
        return;
      case "operand":
        this.#assertStorageSupported(target);
        this.#active().write(target, value, options);
        return;
      case "variable":
        this.#active().write(target, value.unsigned.extend(32));
        return;
      case "reg":
        this.#active().write(target, value);
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
    this.#assertStorageSupported(target);

    switch (target.kind) {
      case "operand":
        assert(width !== undefined, "operand updates require a width");
        return this.#active().update(target, width, options);
      case "variable":
        return this.#active().update(target);
      case "reg":
        return this.#active().update(target);
    }
  }

  addInstructionCount(amount: I32Value): void {
    this.#active().addInstructionCount(amount);
  }

  address(operandRef: OperandRef): I32Value {
    this.#assertOperandSupported(operandRef);
    return this.#active().address(operandRef);
  }

  readFlag(flag: X86Flag): BitValue {
    assert(
      !this.#scope.insideLoop ||
        !isX86StatusFlag(flag) ||
        !this.#state.statusFlags.isInputBacked(flag),
      "input-backed status flag reads inside a loop body are unsupported"
    );
    return this.#active().readFlag(flag);
  }

  writeFlag(flag: X86Flag, value: BitValue): void {
    this.#active().writeFlag(flag, value);
  }

  writeStatusFlagsSource<Width extends OperandWidth>(source: SimpleFlagSource<Width>): void {
    this.#active().writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): BitValue {
    assert(
      !this.#scope.insideLoop || !this.#state.statusFlags.conditionReadsInputFlags(cc),
      "input-backed conditions inside a loop body are unsupported"
    );
    return this.#active().condition(cc);
  }

  jump(target: I32Value): void {
    this.#session.jump(this.#scope, target);
  }

  if(condition: BitValue, thenBuild: IfBody, hint?: SemanticBranchHint): void {
    this.#session.if(this.#scope, condition, thenBuild, hint);
  }

  ifElse(
    condition: BitValue,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.#session.ifElse(this.#scope, condition, thenBuild, elseBuild, hint);
  }

  loop(body: LoopBody): void {
    this.#session.loop(this.#scope, body);
  }

  cpuException(exception: CpuException<I32Value>): void {
    this.#session.cpuException(this.#scope, exception);
  }

  hostTrap(vector: Integer<8>): void {
    this.#session.hostTrap(this.#scope, vector);
  }

  #active(): ScopedInstructionStorage {
    this.#session.assertActive(this.#scope);
    return this.#storage;
  }

  #assertStorageSupported(storage: StorageRef): void {
    if (!this.#scope.insideLoop || storage.kind !== "operand") {
      return;
    }

    assert(
      !this.#operands.operandUsesDynamicGpr(storage.index),
      "dynamic register operands inside a loop body are unsupported"
    );
  }

  #assertUpdateSupported(update: SemanticUpdate<OperandWidth>): void {
    if (update.destination.kind === "storage") {
      this.#assertStorageSupported(update.destination.reference);
    }
  }

  #assertOperandSupported(operandRef: OperandRef): void {
    assert(
      !this.#scope.insideLoop || !this.#operands.operandUsesDynamicGpr(operandRef.index),
      "dynamic register operands inside a loop body are unsupported"
    );
  }
}
