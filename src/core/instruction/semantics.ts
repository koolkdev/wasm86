import type { CpuException } from "#core/exceptions.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import type { X86Flag } from "#core/flags/definitions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type {
  IfBody,
  LoopBody,
  SemanticBranchHint,
  SemanticMemoryOps,
  SemanticReadOptions,
  SemanticsBuilder,
  SemanticUpdate,
  SemanticVar,
  SemanticWriteOptions
} from "#core/semantics/builder.js";
import type {
  OperandInput,
  OperandRef,
  RegRef,
  SegmentRef,
  StorageInput,
  TargetInput,
  Value,
  ValueInput
} from "#core/semantics/refs.js";
import type { RegName } from "#core/types.js";
import type { SemanticRegionScope } from "./scope.js";
import type { ScopedInstructionStorage } from "./storage.js";

// Lifecycle operations supplied by the instruction session. The semantic
// facade adds no transaction policy of its own; it fixes these operations and
// storage to one lexical scope.
export interface InstructionSemanticsSession {
  assertActive(scope: SemanticRegionScope): void;
  currentEip(): Value;
  nextEip(): Value;
  jump(scope: SemanticRegionScope, target: TargetInput): void;
  if(
    scope: SemanticRegionScope,
    condition: ValueInput,
    thenBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  ifElse(
    scope: SemanticRegionScope,
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  loop(scope: SemanticRegionScope, body: LoopBody): void;
  cpuException(
    scope: SemanticRegionScope,
    exception: CpuException<ValueInput>
  ): void;
  hostTrap(scope: SemanticRegionScope, vector: ValueInput): void;
}

// The x86 semantic language projected onto one lexical region. These objects
// are cheap facades over the session's shared transaction state.
export class InstructionSemantics implements SemanticsBuilder {
  readonly #session: InstructionSemanticsSession;
  readonly #scope: SemanticRegionScope;
  readonly #storage: ScopedInstructionStorage;
  readonly memory: SemanticMemoryOps;

  constructor(
    session: InstructionSemanticsSession,
    scope: SemanticRegionScope,
    storage: ScopedInstructionStorage
  ) {
    this.#session = session;
    this.#scope = scope;
    this.#storage = storage;
    this.memory = {
      reference: (segment, offset) =>
        this.#active().memory.reference(segment, offset),
      operand: (operandRef, addressOffset) =>
        this.#active().memory.operand(operandRef, addressOffset),
      guard: (options) => this.#active().memory.guard(options),
      resolve: (options) => this.#active().memory.resolve(options),
      read: (reference, options) =>
        this.#active().memory.read(reference, options),
      write: (reference, options) =>
        this.#active().memory.write(reference, options),
      load: (access, options) => this.#active().memory.load(access, options),
      store: (access, options) => this.#active().memory.store(access, options)
    };
  }

  operand(index: number): OperandRef {
    return this.#active().operand(index);
  }

  currentEip(): Value {
    this.#active();
    return this.#session.currentEip();
  }

  nextEip(): Value {
    this.#active();
    return this.#session.nextEip();
  }

  segment(operandRef: OperandInput): SegmentRef {
    return this.#active().segment(operandRef);
  }

  reg(regInput: RegName): RegRef {
    return this.#active().reg(regInput);
  }

  var(seed: ValueInput): SemanticVar {
    return this.#active().variable(seed);
  }

  read(source: StorageInput, options: SemanticReadOptions): Value {
    return this.#active().read(source, options);
  }

  write(
    target: StorageInput,
    value: ValueInput,
    options: SemanticWriteOptions
  ): void {
    this.#active().write(target, value, options);
  }

  update(
    target: StorageInput,
    options: SemanticWriteOptions
  ): SemanticUpdate {
    return this.#active().update(target, options);
  }

  addInstructionCount(amount: ValueInput): void {
    this.#active().addInstructionCount(amount);
  }

  address(operandRef: OperandInput): Value {
    return this.#active().address(operandRef);
  }

  readFlag(flag: X86Flag): Value {
    return this.#active().readFlag(flag);
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    this.#active().writeFlag(flag, value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#active().writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    return this.#active().condition(cc);
  }

  jump(target: TargetInput): void {
    this.#session.jump(this.#scope, target);
  }

  if(
    condition: ValueInput,
    thenBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.#session.if(this.#scope, condition, thenBuild, hint);
  }

  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    this.#session.ifElse(
      this.#scope,
      condition,
      thenBuild,
      elseBuild,
      hint
    );
  }

  loop(body: LoopBody): void {
    this.#session.loop(this.#scope, body);
  }

  cpuException(exception: CpuException<ValueInput>): void {
    this.#session.cpuException(this.#scope, exception);
  }

  hostTrap(vector: ValueInput): void {
    this.#session.hostTrap(this.#scope, vector);
  }

  #active(): ScopedInstructionStorage {
    this.#session.assertActive(this.#scope);
    return this.#storage;
  }
}
