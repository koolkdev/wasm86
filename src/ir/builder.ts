import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { X86Flag } from "#x86/flags.js";
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
import type { EffectiveAddress, OperandWidth, RegName } from "#x86/types.js";
import { signedComparePredicates, type BinaryOperator, type CompareOperator, type UnaryOperator } from "#x86/semantics/ops.js";
import type {
  ExternalValueId,
  MemDynamicOperandBinding,
  OperandBinding,
  RegDynamicOperandBinding
} from "./operands.js";
import { PendingState } from "./pending.js";
import {
  eipChannel,
  gprChannel,
  instructionCountChannel,
  type GprChannel,
  type StateChannel
} from "./slots.js";
import type {
  Action,
  ContinueAction,
  ExitAction,
  GprDynamicSlot,
  WriteStateAction
} from "./actions.js";
import type { EdgeRegion, IrBlock, RegionId } from "./block.js";
import {
  createValueTable,
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

type InternedInstructionLocation = Readonly<{ eip(): ValueId; nextEip(): ValueId }>;

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
  readonly #values = createValueTable();
  readonly #actions: Action[] = [];
  readonly #pending = new PendingState(this.#values, (action) => this.#actions.push(action));
  readonly #edgeRegions: EdgeRegion[] = [];
  // An effective address is computed once per operand, at its first use —
  // x86 computes an EA once, so later uses (the store) see the same address
  // even when the instruction rewrites a base register in between.
  readonly #operandAddresses = new Map<number, ValueId>();
  #nextRegionId: RegionId = entryRegionId + 1;
  #bindings: readonly OperandBinding[] = [];
  #instructionLocation: InternedInstructionLocation | undefined;
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
    this.#instructionLocation = this.#internLocation(location);
    this.#terminated = false;
    this.#wroteMemory = false;
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

    let continuation: ValueId | undefined;

    switch (this.#blockEnd) {
      case "fallthrough":
      case "jump":
        assert(this.#pending.has(eipChannel), "IR block did not advance eip; no instructions were added");
        continuation = this.#pending.read(eipChannel);
        this.#flushCompletedState();
        this.#actions.push({ kind: "continue" });
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
          actions: this.#actions,
          ...(continuation === undefined ? {} : { continuation })
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
    return valueFromId(this.#values.internConst(value));
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
            return valueFromId(this.#widthAdjusted(this.#values.internConst(binding.value), accessWidth, options));
          case "immExternal":
            return valueFromId(this.#widthAdjusted(this.#values.internExternal(binding.value), accessWidth, options));
          case "reg":
            return valueFromId(this.#readChannel(binding.channel, accessWidth, options));
          case "mem":
          case "memStatic":
          case "memDynamic":
            return valueFromId(this.#readMemory(this.#operandAddress(storage.index), accessWidth, options));
          case "regDynamic":
            return valueFromId(
              this.#pending.readDynamicGpr(this.#dynamicGprSlot(binding, accessWidth), options)
            );
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
          case "mem":
          case "memStatic":
          case "memDynamic":
            this.#writeMemory(this.#operandAddress(storage.index), value, accessWidth);
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

  i32Add(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32Add", "add", a, b);
  }

  i32Sub(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32Sub", "sub", a, b);
  }

  i32Xor(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32Xor", "xor", a, b);
  }

  i32Or(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32Or", "or", a, b);
  }

  i32And(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32And", "and", a, b);
  }

  i32Shl(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32Shl", "shl", a, b);
  }

  i32ShrU(a: ValueInput, b: ValueInput): Value {
    return this.#binary("i32ShrU", "shr_u", a, b);
  }

  i32Extend8S(value: ValueInput): Value {
    this.#beforeOp("i32Extend8S");
    return valueFromId(this.#values.extendTo(8, value));
  }

  i32Extend16S(value: ValueInput): Value {
    this.#beforeOp("i32Extend16S");
    return valueFromId(this.#values.extendTo(16, value));
  }

  i32Popcnt(value: ValueInput): Value {
    return this.#unary("i32Popcnt", "popcnt", value);
  }

  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value {
    this.#beforeOp("i32Select");
    return valueFromId(this.#values.internSelect(condition, whenTrue, whenFalse));
  }

  project(width: OperandWidth, value: ValueInput): Value {
    this.#beforeOp("project");
    return valueFromId(this.#values.projectTo(width, value));
  }

  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    this.#beforeOp("compare");
    // Narrow compares lower by predicate class: signed predicates need
    // sign-extended operands, the rest masked ones.
    const lower = signedComparePredicates.has(operator)
      ? (id: ValueId) => this.#values.extendTo(width, id)
      : (id: ValueId) => this.#values.projectTo(width, id);

    return valueFromId(
      this.#values.internCompare(operator, lower(a), lower(b))
    );
  }

  readFlag(flag: X86Flag): Value {
    this.#beforeOp("readFlag");
    return valueFromId(this.#pending.readFlag(flag));
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    this.#beforeOp("writeFlag");
    this.#pending.writeFlag(flag, value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#beforeOp("writeStatusFlagsSource");
    this.#pending.writeStatusFlagsSource(source);
  }

  condition(cc: ConditionCode): Value {
    this.#beforeOp("condition");
    return valueFromId(this.#pending.condition(cc));
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
    this.#flushCompletedState();
    this.#actions.push({ kind: "exit", reason: "hostTrap", payload: vectorId });
    this.#blockEnd = "terminated";
    this.#terminated = true;
  }

  #binary(op: string, operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    this.#beforeOp(op);
    return valueFromId(this.#values.internBinary(operator, a, b));
  }

  #unary(op: string, operator: UnaryOperator, value: ValueInput): Value {
    this.#beforeOp(op);
    return valueFromId(this.#values.internUnary(operator, value));
  }

  // The snapshot leaves the main-path map untouched. Pending eip holds the
  // previous instruction's nextEip; the edge stores the faulting eip instead.
  #faultEdge(reason: "memoryReadFault" | "memoryWriteFault", address: ValueId): RegionId {
    return this.#edgeRegion(
      { kind: "exit", reason, payload: address },
      this.#pending.snapshot(),
      this.#location().eip()
    );
  }

  // Branch edges observe the completed instruction, so they flush live
  // pendings.
  #branchEdge(target: TargetInput): RegionId {
    return this.#edgeRegion(
      { kind: "continue" },
      this.#pending.entries(),
      target
    );
  }

  #flushCompletedState(): void {
    this.#pending.flushAll();
  }

  #edgeRegion(
    terminator: ExitAction | ContinueAction,
    pendings: ReadonlyArray<readonly [StateChannel, ValueId]>,
    eipValue: ValueId
  ): RegionId {
    const flushes: WriteStateAction[] = [];
    let wroteEip = false;

    for (const [slot, value] of pendings) {
      if (slot === eipChannel) {
        wroteEip = true;
        flushes.push({ kind: "writeState", slot, value: eipValue });
      } else {
        flushes.push({ kind: "writeState", slot, value });
      }
    }

    if (!wroteEip) {
      flushes.push({ kind: "writeState", slot: eipChannel, value: eipValue });
    }

    const id = this.#nextRegionId;

    this.#nextRegionId += 1;
    this.#edgeRegions.push({
      id,
      kind: "edge",
      flushes,
      terminator,
      ...(terminator.kind === "continue" ? { continuation: eipValue } : {})
    });
    return id;
  }

  // Every terminator advances the count: fault edges snapshot the
  // instruction boundary, so a faulting instruction never counts. The value
  // is always base + completed off the block's one read, so a flush stores
  // a single folded add.
  #advanceInstructionCount(): void {
    this.#instructionCountBase ??= this.#pending.read(instructionCountChannel);
    this.#instructionsCompleted += 1;
    this.#pending.write(
      instructionCountChannel,
      this.#values.internBinary(
        "add",
        this.#instructionCountBase,
        this.#values.internConst(this.#instructionsCompleted)
      )
    );
  }

  #dynamicGprSlot(binding: RegDynamicOperandBinding, accessWidth: OperandWidth): GprDynamicSlot {
    return {
      kind: "gprDynamic",
      index: this.#values.internExternal(binding.index),
      byteLength: dynamicGprByteLength[accessWidth]
    };
  }

  #widthAdjusted(value: ValueId, accessWidth: OperandWidth, options: GetOptions): ValueId {
    return options.signed === true
      ? this.#values.extendTo(accessWidth, value)
      : this.#values.projectTo(accessWidth, value);
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

  #bindingAddress(binding: OperandBinding): ValueId {
    assert(
      binding.kind === "mem" || binding.kind === "memStatic" || binding.kind === "memDynamic",
      `address of a ${binding.kind} operand binding`
    );

    switch (binding.kind) {
      case "mem":
        return this.#effectiveAddress(binding.address);
      case "memStatic":
        return this.#values.internExternal(binding.address);
      case "memDynamic":
        return this.#dynamicAddress(binding);
    }
  }

  #dynamicAddress(binding: MemDynamicOperandBinding): ValueId {
    const base = this.#pending.readDynamicGpr({
      kind: "gprDynamic",
      index: this.#values.internExternal(binding.base),
      byteLength: 4
    });

    return this.#values.internBinary("add", base, this.#values.internExternal(binding.offset));
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
        : this.#values.internBinary("shl", index, this.#values.internConst(scaleShift[ea.scale]));

      address = address === undefined ? scaled : this.#values.internBinary("add", address, scaled);
    }

    if (address === undefined) {
      return this.#values.internConst(ea.disp);
    }

    return ea.disp === 0
      ? address
      : this.#values.internBinary("add", address, this.#values.internConst(ea.disp));
  }

  #binding(index: number): OperandBinding {
    const binding = this.#bindings[index];

    assert(binding !== undefined, `missing operand binding for operand ${index}`);
    return binding;
  }

  #internLocation(location: InstructionLocation): InternedInstructionLocation {
    return {
      eip: this.#internLocationValue(location.eip),
      nextEip: this.#internLocationValue(location.nextEip)
    };
  }

  #internLocationValue(source: InstructionAddressSource): () => ValueId {
    let interned: ValueId | undefined;

    return () => {
      if (interned !== undefined) {
        return interned;
      }

      switch (source.kind) {
        case "const":
          interned = this.#values.internConst(source.address);
          return interned;
        case "external":
          interned = this.#values.internExternal(source.external);
          return interned;
      }
    };
  }

  #location(): InternedInstructionLocation {
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
