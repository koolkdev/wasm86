import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import { isX86StatusFlag, type X86Flag } from "#x86/flags.js";
import type { MemoryAccessKind } from "#x86/memory-access.js";
import { mem, operand, reg, toStorageRef } from "#x86/semantics/refs.js";
import type {
  SemanticsBuilder,
  GetOptions,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticTemplate,
  SimpleFlagSource
} from "#x86/semantics/builder.js";
import type {
  MemRef,
  OperandInput,
  OperandRef,
  RegRef,
  StorageInput,
  TargetInput,
  Value,
  ValueInput
} from "#x86/semantics/refs.js";
import type { EffectiveAddress, OperandWidth, RegName, SegmentRegister } from "#x86/types.js";
import {
  signedComparePredicates,
  type BinaryOperator,
  type CompareOperator,
  type UnaryOperator
} from "#x86/semantics/ops.js";
import type {
  ExternalValueId,
  MemDynamicSegment,
  MemDynamicOperandBinding,
  OperandBinding,
  RegDynamicOperandBinding,
  SegmentDynamicOperandBinding
} from "./operands.js";
import { PendingState } from "./pending/state.js";
import { StatusFlags } from "./status-flags.js";
import {
  eipChannel,
  flagChannel,
  gprChannel,
  instructionCountChannel,
  segmentBaseChannel,
  type GprDynamicSlot,
  type GprChannel
} from "./slots.js";
import type {
  Action,
  DispatchAction,
  EdgeFlushAction,
  ExitAction
} from "./actions.js";
import type { EdgeRegion, IrBlock, RegionId } from "./block.js";
import {
  ValueTable,
  fitsUnsigned,
  signExtended,
  type ValueId,
  type WidthBounds
} from "./values.js";

// Instruction addresses are known at block-compile time for JIT blocks, but
// interpreter handlers receive them from host locals so one handler can serve
// many decoded instructions.
export type InstructionAddressSource =
  | Readonly<{ kind: "const"; address: number }>
  | Readonly<{ kind: "external"; external: ExternalValueId }>;

export type InstructionLocation = Readonly<{
  eip: InstructionAddressSource;
  nextEip: InstructionAddressSource;
}>;

type InstructionLocationValues = Readonly<{ eip(): ValueId; nextEip(): ValueId }>;

export type IrBlockBuilder = Readonly<{
  addInstruction(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void;
  finish(): IrBlock;
}>;

export function createIrBlockBuilder(): IrBlockBuilder {
  const builder = new IrBlockBuilderImpl();

  return {
    addInstruction: (template, bindings, location) => builder.addInstruction(template, bindings, location),
    finish: () => builder.finish()
  };
}

export function staticInstructionLocation(eip: number, nextEip: number): InstructionLocation {
  return {
    eip: { kind: "const", address: eip },
    nextEip: { kind: "const", address: nextEip }
  };
}

export function externalInstructionLocation(
  eip: ExternalValueId,
  nextEip: ExternalValueId
): InstructionLocation {
  return {
    eip: { kind: "external", external: eip },
    nextEip: { kind: "external", external: nextEip }
  };
}

const entryRegionId: RegionId = 0;

function valueFromId(id: ValueId): Value {
  return id as Value;
}

class IrBlockBuilderImpl implements SemanticsBuilder, SemanticBuildContext {
  readonly #values = new ValueTable();
  readonly #actions: Action[] = [];
  readonly #pending = new PendingState(this.#values, (action) => this.#actions.push(action));
  readonly #statusFlags = new StatusFlags(this.#values, this.#pending);
  readonly #edgeRegions: EdgeRegion[] = [];
  // An effective/linear address is computed once per operand, at its first
  // use, so later uses see the same address even if the instruction rewrites
  // a base register in between.
  readonly #operandAddresses = new Map<number, ValueId>();
  readonly #operandLinearAddresses = new Map<number, ValueId>();
  readonly #dynamicSegmentBases = new Map<ExternalValueId, ValueId>();
  #nextRegionId: RegionId = entryRegionId + 1;
  #bindings: readonly OperandBinding[] = [];
  #instructionLocation: InstructionLocationValues | undefined;
  #instructionCountBase: ValueId | undefined;
  #instructionsCompleted = 0;
  #terminated = false;
  #wroteMemory = false;
  #finished = false;
  // "terminated" means the entry region already holds its terminator.
  #blockEnd: "fallthrough" | "jump" | "terminated" = "fallthrough";

  addInstruction(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void {
    assert(!this.#finished, "cannot add instructions to a finished IR block builder");
    assert(this.#blockEnd === "fallthrough", "cannot add instructions after a block terminator");
    assert(this.#instructionLocation === undefined, "IR block builder has an incomplete instruction");

    this.#bindings = bindings;
    this.#operandAddresses.clear();
    this.#operandLinearAddresses.clear();
    this.#dynamicSegmentBases.clear();
    this.#instructionLocation = this.#locationValues(location);
    this.#terminated = false;
    this.#wroteMemory = false;
    this.#pending.write(eipChannel, this.#location().eip());
    this.#pending.beginInstruction();

    template(this, this);

    if (!this.#terminated) {
      this.next();
    }

    // Cleared only on success: a template that throws leaves the instruction
    // in place with its partial pendings, poisoning further use.
    this.#instructionLocation = undefined;
    this.#bindings = [];
  }

  finish(): IrBlock {
    assert(!this.#finished, "IR block builder is already finished");
    assert(this.#instructionLocation === undefined, "IR block builder has an incomplete instruction");
    this.#finished = true;

    switch (this.#blockEnd) {
      case "fallthrough":
      case "jump":
        assert(this.#pending.has(eipChannel), "IR block did not advance eip; no instructions were added");
        this.#actions.push(...this.#pending.flushesForEdge("completed"));
        this.#actions.push({ kind: "dispatch", targetEip: this.#pending.read(eipChannel) });
        break;
      case "terminated":
        break;
    }

    return {
      entry: entryRegionId,
      regions: [
        {
          id: entryRegionId,
          kind: "entry",
          actions: this.#actions
        },
        ...this.#edgeRegions
      ],
      values: this.#values
    };
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const binding = this.#binding(operandInput.index);

    switch (binding.kind) {
      case "reg":
      case "segment":
        return { storage: "reg" };
      case "imm":
        return { storage: "imm" };
      case "mem":
      case "memStatic":
      case "memDynamic":
        return { storage: "mem" };
      case "regDynamic":
        // A runtime register index: register storage, dynamic channel.
        return { storage: "reg" };
      case "segmentDynamic":
        // A runtime segment index: register-like storage, selector channel.
        return { storage: "reg" };
      case "immExternal":
        // A runtime value with no storage cell, e.g. a decoded immediate.
        return { storage: "imm" };
    }
  }

  operand(index: number): OperandRef {
    this.#binding(index);
    return operand(index);
  }

  const32(value: number): Value {
    this.#beforeOp("const32");
    return valueFromId(this.#values.const(value));
  }

  nextEip(): Value {
    this.#beforeOp("nextEip");
    return valueFromId(this.#location().nextEip());
  }

  reg(regInput: RegName): RegRef {
    return reg(regInput);
  }

  mem(address: ValueInput): MemRef {
    return mem(address);
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: GetOptions = {}): Value {
    this.#beforeOp("get");
    const storage = toStorageRef(source);

    switch (storage.kind) {
      case "reg":
        return valueFromId(this.#readChannel(gprChannel(storage.reg), accessWidth, options));
      case "mem":
        return valueFromId(this.#readMemory(storage.address, accessWidth, options));
      case "operand": {
        const binding = this.#binding(storage.index);

        switch (binding.kind) {
          case "imm":
            return valueFromId(this.#widthAdjusted(this.#values.const(binding.value), accessWidth, options));
          case "immExternal":
            return valueFromId(this.#widthAdjusted(this.#values.external(binding.value), accessWidth, options));
          case "reg":
            return valueFromId(this.#readChannel(binding.channel, accessWidth, options));
          case "segment":
            return valueFromId(this.#widthAdjusted(this.#pending.read(binding.channel), accessWidth, options));
          case "mem":
          case "memStatic":
          case "memDynamic":
            return valueFromId(this.#readMemory(this.#operandLinearAddress(storage.index), accessWidth, options));
          case "regDynamic":
            return valueFromId(
              this.#pending.readDynamicGpr(this.#dynamicGprSlot(binding, accessWidth), options)
            );
          case "segmentDynamic":
            return valueFromId(this.#dynamicSegmentSelector(binding, accessWidth, options));
        }
      }
    }
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    this.#beforeOp("set");
    const storage = toStorageRef(target);

    switch (storage.kind) {
      case "reg":
        this.#writeChannel(gprChannel(storage.reg), value, accessWidth);
        return;
      case "mem":
        this.#writeMemory(storage.address, value, accessWidth);
        return;
      case "operand": {
        const binding = this.#binding(storage.index);

        switch (binding.kind) {
          case "reg":
            this.#writeChannel(binding.channel, value, accessWidth);
            return;
          case "segment":
          case "segmentDynamic":
            throw notSupportedError(`set to ${binding.kind} operand binding`);
          case "mem":
          case "memStatic":
          case "memDynamic":
            this.#writeMemory(this.#operandLinearAddress(storage.index), value, accessWidth);
            return;
          case "regDynamic":
            this.#pending.writeDynamicGpr(this.#dynamicGprSlot(binding, accessWidth), value);
            return;
          case "imm":
          case "immExternal":
            throw notSupportedError(`set to ${binding.kind} operand binding`);
        }
      }
    }
  }

  next(): void {
    this.#beforeOp("next");
    this.#advanceInstructionCount();
    this.#pending.write(eipChannel, this.#location().nextEip());
    this.#terminated = true;
  }

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    this.#beforeOp("memoryGuard");
    // Guest memory cannot be rolled back by any scheme, so a fault edge
    // cannot restore the pre-instruction state once the instruction stored.
    assert(!this.#wroteMemory, "a memory guard cannot follow a memory write in the same instruction");

    const addressId = address;

    this.#actions.push({
      kind: "guardMemory",
      address: addressId,
      byteLength,
      access,
      faultEdge: this.#faultEdge(access === "read" ? "memoryReadFault" : "memoryWriteFault", addressId)
    });
  }

  address(operandRef: OperandInput): Value {
    this.#beforeOp("address");
    return valueFromId(this.#operandAddress(operandRef.index));
  }

  linearAddress(operandRef: OperandInput): Value {
    this.#beforeOp("linearAddress");
    return valueFromId(this.#operandLinearAddress(operandRef.index));
  }

  binary(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    this.#beforeOp("binary");
    return valueFromId(this.#values.binary(operator, a, b));
  }

  unary(operator: UnaryOperator, value: ValueInput): Value {
    this.#beforeOp("unary");
    return valueFromId(this.#values.unary(operator, value));
  }

  binary64(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    this.#beforeOp("binary64");
    return valueFromId(this.#values.binary64(operator, a, b));
  }

  compare64(operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    this.#beforeOp("compare64");
    return valueFromId(this.#values.compare64(operator, a, b));
  }

  truncate64(width: OperandWidth, value: ValueInput): Value {
    this.#beforeOp("truncate64");
    return valueFromId(this.#values.truncate64(width, value));
  }

  extend64(width: OperandWidth, value: ValueInput, signed: boolean): Value {
    this.#beforeOp("extend64");
    return valueFromId(this.#values.extend64(width, value, signed));
  }

  select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value {
    this.#beforeOp("select");
    return valueFromId(this.#values.select(condition, whenTrue, whenFalse));
  }

  truncate(width: OperandWidth, value: ValueInput): Value {
    this.#beforeOp("truncate");
    return valueFromId(this.#values.truncate(width, value));
  }

  extend(width: OperandWidth, value: ValueInput, signed: boolean): Value {
    this.#beforeOp("extend");
    return valueFromId(this.#values.extend(width, value, signed));
  }

  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    this.#beforeOp("compare");
    // Narrow compares lower by predicate class: signed predicates need
    // sign-extended operands, the rest masked ones.
    const lower = signedComparePredicates.has(operator)
      ? (id: ValueId) => this.#values.extend(width, id, true)
      : (id: ValueId) => this.#values.truncate(width, id);

    return valueFromId(
      this.#values.compare(operator, lower(a), lower(b))
    );
  }

  readFlag(flag: X86Flag): Value {
    this.#beforeOp("readFlag");
    return valueFromId(
      isX86StatusFlag(flag)
        ? this.#statusFlags.readFlag(flag)
        : this.#pending.read(flagChannel(flag))
    );
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    this.#beforeOp("writeFlag");
    if (isX86StatusFlag(flag)) {
      this.#statusFlags.writeFlag(flag, value);
      return;
    }

    this.#pending.write(flagChannel(flag), value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#beforeOp("writeStatusFlagsSource");
    this.#statusFlags.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    this.#beforeOp("condition");
    return valueFromId(this.#statusFlags.condition(cc));
  }

  jump(target: TargetInput): void {
    this.#beforeOp("jump");
    this.#advanceInstructionCount();
    this.#pending.write(eipChannel, target);
    this.#blockEnd = "jump";
    this.#terminated = true;
  }

  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void {
    this.#beforeOp("conditionalJump");
    this.#advanceInstructionCount();

    const conditionId = condition;

    this.#actions.push({
      kind: "branch",
      condition: conditionId,
      taken: this.#branchEdge(taken),
      notTaken: this.#branchEdge(notTaken)
    });
    this.#blockEnd = "terminated";
    this.#terminated = true;
  }

  // A trap resumes at the next instruction with all state observable.
  hostTrap(vector: ValueInput): void {
    this.#beforeOp("hostTrap");
    this.#advanceInstructionCount();

    const vectorId = vector;

    this.#pending.write(eipChannel, this.#location().nextEip());
    this.#actions.push(...this.#pending.flushesForEdge("completed"));
    this.#actions.push({ kind: "exit", reason: "hostTrap", payload: vectorId });
    this.#blockEnd = "terminated";
    this.#terminated = true;
  }

  // Fault edges restore the instruction-start state captured by
  // beginInstruction, including the faulting instruction's eip.
  #faultEdge(reason: "memoryReadFault" | "memoryWriteFault", address: ValueId): RegionId {
    return this.#edgeRegion(
      { kind: "exit", reason, payload: address },
      this.#pending.flushesForEdge("fault")
    );
  }

  // Branch edges observe the completed instruction.
  #branchEdge(target: TargetInput): RegionId {
    this.#pending.write(eipChannel, target);

    return this.#edgeRegion(
      { kind: "dispatch", targetEip: target },
      this.#pending.flushesForEdge("completed")
    );
  }

  #edgeRegion(
    terminator: ExitAction | DispatchAction,
    flushes: readonly EdgeFlushAction[]
  ): RegionId {
    const id = this.#nextRegionId;

    this.#nextRegionId += 1;

    this.#edgeRegions.push({
      id,
      kind: "edge",
      flushes,
      terminator
    });

    return id;
  }

  // Every terminator advances the count: fault edges commit instruction-start
  // state, so a faulting instruction never counts. The value
  // is always base + completed off the block's one read, so a flush stores
  // a single folded add.
  #advanceInstructionCount(): void {
    this.#instructionCountBase ??= this.#pending.read(instructionCountChannel);
    this.#instructionsCompleted += 1;
    this.#pending.write(
      instructionCountChannel,
      this.#values.binary(
        "add",
        this.#instructionCountBase,
        this.#values.const(this.#instructionsCompleted)
      )
    );
  }

  #dynamicGprSlot(binding: RegDynamicOperandBinding, accessWidth: OperandWidth): GprDynamicSlot {
    return {
      kind: "gprDynamic",
      index: this.#values.external(binding.index),
      byteLength: dynamicGprByteLength[accessWidth]
    };
  }

  #dynamicSegmentSelector(
    binding: SegmentDynamicOperandBinding,
    accessWidth: OperandWidth,
    options: GetOptions
  ): ValueId {
    return this.#widthAdjusted(
      this.#pending.readDynamicSegmentSelector(this.#values.external(binding.index)),
      accessWidth,
      options
    );
  }

  #widthAdjusted(value: ValueId, accessWidth: OperandWidth, options: GetOptions): ValueId {
    return options.signed === true
      ? this.#values.extend(accessWidth, value, true)
      : this.#values.truncate(accessWidth, value);
  }

  #readChannel(channel: GprChannel, accessWidth: OperandWidth, options: GetOptions): ValueId {
    assert(
      channel.byteLength * 8 === accessWidth,
      `${accessWidth}-bit get from a ${channel.byteLength * 8}-bit register channel`
    );
    return this.#pending.read(channel, options);
  }

  #writeChannel(channel: GprChannel, value: ValueInput, accessWidth: OperandWidth): void {
    assert(
      channel.byteLength * 8 === accessWidth,
      `${accessWidth}-bit set to a ${channel.byteLength * 8}-bit register channel`
    );
    this.#pending.write(channel, value);
  }

  #readMemory(address: ValueId, width: OperandWidth, options: GetOptions): ValueId {
    // Sign-extension is meaningful only below the word, as in pending reads.
    const signed = options.signed === true && width !== 32;
    const output = this.#values.addActionOutput(memoryReadBounds(width, signed));

    this.#actions.push(
      signed
        ? { kind: "readMemory", output, address, width, signed: true }
        : { kind: "readMemory", output, address, width }
    );
    return output;
  }

  #writeMemory(address: ValueId, value: ValueInput, width: OperandWidth): void {
    this.#wroteMemory = true;
    this.#actions.push({ kind: "writeMemory", address, value, width });
  }

  #operandAddress(index: number): ValueId {
    const cached = this.#operandAddresses.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const binding = this.#binding(index);
    const address = this.#bindingAddress(binding);

    this.#operandAddresses.set(index, address);
    return address;
  }

  #operandLinearAddress(index: number): ValueId {
    const cached = this.#operandLinearAddresses.get(index);

    if (cached !== undefined) {
      return cached;
    }

    const binding = this.#binding(index);
    const address = this.#bindingLinearAddress(index, binding);

    this.#operandLinearAddresses.set(index, address);
    return address;
  }

  #bindingAddress(binding: OperandBinding): ValueId {
    assert(
      binding.kind === "mem" || binding.kind === "memStatic" || binding.kind === "memDynamic",
      `address of a ${binding.kind} operand binding`
    );

    switch (binding.kind) {
      case "mem":
        return this.#effectiveAddress(binding.address);
      case "memStatic":
        return this.#values.external(binding.address);
      case "memDynamic":
        return this.#dynamicAddress(binding);
    }
  }

  #bindingLinearAddress(index: number, binding: OperandBinding): ValueId {
    assert(
      binding.kind === "mem" || binding.kind === "memStatic" || binding.kind === "memDynamic",
      `linear address of a ${binding.kind} operand binding`
    );

    switch (binding.kind) {
      case "mem":
        return this.#linearAddress(binding.address.segment, this.#operandAddress(index));
      case "memStatic":
        return this.#operandAddress(index);
      case "memDynamic":
        return this.#memDynamicLinearAddress(binding.segment, this.#operandAddress(index));
    }
  }

  #dynamicAddress(binding: MemDynamicOperandBinding): ValueId {
    const base = this.#pending.readDynamicGpr({
      kind: "gprDynamic",
      index: this.#values.external(binding.base),
      byteLength: 4
    });

    return this.#values.binary("add", base, this.#values.external(binding.offset));
  }

  #effectiveAddress(ea: EffectiveAddress): ValueId {
    let address: ValueId | undefined;

    if (ea.base !== undefined) {
      address = this.#pending.read(gprChannel(ea.base));
    }

    if (ea.index !== undefined) {
      const index = this.#pending.read(gprChannel(ea.index));
      const scaled = ea.scale === 1
        ? index
        : this.#values.binary("shl", index, this.#values.const(scaleShift[ea.scale]));

      address = address === undefined ? scaled : this.#values.binary("add", address, scaled);
    }

    if (address === undefined) {
      return this.#values.const(ea.disp);
    }

    return ea.disp === 0
      ? address
      : this.#values.binary("add", address, this.#values.const(ea.disp));
  }

  #linearAddress(segment: SegmentRegister | undefined, offset: ValueId): ValueId {
    // Flat-memory assumption: CS/DS/ES/SS bases are zero; FS/GS may be non-zero.
    if (segment !== "fs" && segment !== "gs") {
      return offset;
    }

    return this.#values.binary("add", this.#pending.read(segmentBaseChannel(segment)), offset);
  }

  #memDynamicLinearAddress(segment: MemDynamicSegment | undefined, offset: ValueId): ValueId {
    switch (segment?.kind) {
      case undefined:
        return offset;
      case "static":
        return this.#linearAddress(segment.reg, offset);
      case "dynamic":
        return this.#dynamicSegmentLinearAddress(segment.value, offset);
    }
  }

  #dynamicSegmentLinearAddress(segment: ExternalValueId, offset: ValueId): ValueId {
    let base = this.#dynamicSegmentBases.get(segment);

    if (base === undefined) {
      base = this.#pending.readDynamicSegmentBase(this.#values.external(segment));
      this.#dynamicSegmentBases.set(segment, base);
    }

    return this.#values.binary("add", base, offset);
  }

  #binding(index: number): OperandBinding {
    const binding = this.#bindings[index];

    assert(binding !== undefined, `missing operand binding for operand ${index}`);
    return binding;
  }

  #locationValues(location: InstructionLocation): InstructionLocationValues {
    return {
      eip: this.#locationValue(location.eip),
      nextEip: this.#locationValue(location.nextEip)
    };
  }

  #locationValue(source: InstructionAddressSource): () => ValueId {
    switch (source.kind) {
      case "const":
        return () => this.#values.const(source.address);
      case "external":
        return () => this.#values.external(source.external);
    }
  }

  #location(): InstructionLocationValues {
    assert(this.#instructionLocation !== undefined, "IR block builder has no current instruction");
    return this.#instructionLocation;
  }

  #beforeOp(op: string): void {
    this.#location();
    assert(!this.#terminated, `cannot emit ${op} after instruction terminator`);
  }
}

const scaleShift = { 1: 0, 2: 1, 4: 2, 8: 3 } as const;

const dynamicGprByteLength = { 8: 1, 16: 2, 32: 4 } as const;

function memoryReadBounds(width: OperandWidth, signed: boolean): WidthBounds | undefined {
  if (width === 32) {
    return undefined;
  }

  return signed ? signExtended(width) : fitsUnsigned(width);
}

function notSupportedError(what: string): Error {
  return new Error(`${what} not supported by IR block builder yet`);
}
