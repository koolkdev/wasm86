import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { CpuException } from "#x86/exceptions.js";
import { isX86StatusFlag, type X86Flag } from "#x86/flags.js";
import { mem, operand, reg, toStorageRef } from "#x86/semantics/refs.js";
import type {
  SemanticsBuilder,
  GetOptions,
  LoopOptions,
  MemoryAccessKind,
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
import type { OperandWidth, RegName, SegmentRegister } from "#x86/types.js";
import type {
  BinaryOperator,
  CompareOperator,
  UnaryOperator
} from "#x86/semantics/ops.js";
import type {
  ExternalValueId,
  EffectiveAddressTerms,
  MemDynamicOperandBinding,
  MemSegmentBinding,
  OperandBinding,
  RegDynamicOperandBinding,
  SegmentDynamicOperandBinding,
  SegmentOperandBinding
} from "./operands.js";
import { LoopBuilder, LoopSemanticsBuilderImpl } from "./builder/loop.js";
import { State } from "./builder/state/index.js";
import type { SegmentMode } from "./builder/state/segments.js";
import {
  type GprDynamicSlot
} from "./slots.js";
import type {
  Action,
  Finish
} from "./actions.js";
import type { Body, IrBlock } from "./block.js";
import { memoryGuardActions } from "./memory-guard.js";
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
  isTerminated(): boolean;
  finish(): IrBlock;
}>;

export type IrBlockBuilderOptions = Readonly<{
  segmentMode?: SegmentMode;
}>;

export function createIrBlockBuilder(options: IrBlockBuilderOptions = {}): IrBlockBuilder {
  const builder = new IrBlockBuilderImpl(options.segmentMode ?? "flat32");

  return {
    addInstruction: (template, bindings, location) => builder.addInstruction(template, bindings, location),
    isTerminated: () => builder.isTerminated(),
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

function valueFromId(id: ValueId): Value {
  return id as Value;
}

class IrBlockBuilderImpl implements SemanticsBuilder, SemanticBuildContext {
  readonly #values = new ValueTable();
  readonly #actions: Action[] = [];
  readonly #state: State;
  #activeLoop: LoopBuilder | undefined;
  // An effective/linear address is computed once per operand, at its first
  // use, so later uses see the same address even if the instruction rewrites
  // a base register in between.
  readonly #operandAddresses = new Map<number, ValueId>();
  readonly #operandLinearAddresses = new Map<number, ValueId>();
  #bindings: readonly OperandBinding[] = [];
  #instructionLocation: InstructionLocationValues | undefined;
  #terminated = false;
  #wroteMemory = false;
  #finished = false;
  // "terminated" means the root body already holds its terminator.
  #blockEnd: "fallthrough" | "jump" | "terminated" = "fallthrough";

  constructor(segmentMode: SegmentMode) {
    this.#state = new State(
      this.#values,
      (action) => this.#emitAction(action),
      segmentMode,
      (finish, actions) => this.#terminate(finish, actions)
    );
  }

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
    this.#instructionLocation = this.#locationValues(location);
    this.#terminated = false;
    this.#wroteMemory = false;
    this.#state.beginInstruction(this.#location().eip());

    template(this, this);

    if (!this.#terminated) {
      this.next();
    }

    // Cleared only on success: a template that throws leaves the instruction
    // in place with its partial pendings, poisoning further use.
    this.#instructionLocation = undefined;
    this.#bindings = [];
  }

  isTerminated(): boolean {
    return this.#blockEnd === "terminated";
  }

  finish(): IrBlock {
    assert(!this.#finished, "IR block builder is already finished");
    assert(this.#instructionLocation === undefined, "IR block builder has an incomplete instruction");
    this.#finished = true;

    switch (this.#blockEnd) {
      case "fallthrough":
      case "jump":
        assert(this.#state.eip.has(), "IR block did not advance eip; no instructions were added");
        const targetEip = this.#state.takeEipForDispatch();

        this.#actions.push(...this.#state.flushesForCompletedDispatch());
        this.#actions.push({
          kind: "finish",
          finish: { kind: "dispatch", targetEip }
        });
        break;
      case "terminated":
        break;
    }

    return {
      body: { actions: this.#actions },
      values: this.#values
    };
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const binding = this.#binding(operandInput.index);

    switch (binding.kind) {
      case "reg":
        return { storage: "reg" };
      case "segment":
        return { storage: "reg", segment: { kind: "static", reg: binding.channel.reg } };
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
        return { storage: "reg", segment: { kind: "dynamic", index: valueFromId(this.#values.external(binding.index)) } };
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

  const64(value: bigint): Value {
    this.#beforeOp("const64");
    return valueFromId(this.#values.const64(value));
  }

  currentEip(): Value {
    this.#beforeOp("currentEip");
    return valueFromId(this.#location().eip());
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
        return valueFromId(this.#state.gpr.read(storage.reg, accessWidth, options));
      case "mem":
        return valueFromId(this.#readGuestMemory(storage.address, accessWidth, options));
      case "operand": {
        const binding = this.#binding(storage.index);

        switch (binding.kind) {
          case "imm":
            return valueFromId(
              this.#values.widthAdjusted(accessWidth, this.#values.const(binding.value), options.signed === true)
            );
          case "immExternal":
            return valueFromId(
              this.#values.widthAdjusted(accessWidth, this.#values.external(binding.value), options.signed === true)
            );
          case "reg":
            return valueFromId(this.#state.gpr.read(binding.channel, accessWidth, options));
          case "segment":
            return valueFromId(this.#state.segments.readSelector(binding.channel, accessWidth, options));
          case "mem":
          case "memStatic":
          case "memDynamic":
            return valueFromId(this.#readGuestMemory(this.#operandLinearAddress(storage.index), accessWidth, options));
          case "regDynamic":
            return valueFromId(
              this.#state.gpr.readDynamic(this.#dynamicGprSlot(binding, accessWidth), options)
            );
          case "segmentDynamic":
            return valueFromId(
              this.#state.segments.readDynamicSelector(this.#values.external(binding.index), accessWidth, options)
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
        this.#state.gpr.write(storage.reg, value, accessWidth);
        return;
      case "mem":
        this.#writeGuestMemory(storage.address, value, accessWidth);
        return;
      case "operand": {
        const binding = this.#binding(storage.index);

        switch (binding.kind) {
          case "reg":
            this.#state.gpr.write(binding.channel, value, accessWidth);
            return;
          case "segment":
          case "segmentDynamic":
            this.#writeSegmentSelector(binding, value, accessWidth);
            return;
          case "mem":
          case "memStatic":
          case "memDynamic":
            this.#writeGuestMemory(this.#operandLinearAddress(storage.index), value, accessWidth);
            return;
          case "regDynamic":
            this.#state.gpr.writeDynamic(this.#dynamicGprSlot(binding, accessWidth), value);
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
    this.#state.instructionCount.increment();
    this.#state.eip.write(this.#location().nextEip());
    this.#terminated = true;
  }

  addInstructionCount(amount: ValueInput): void {
    this.#beforeOp("addInstructionCount");
    this.#state.instructionCount.add(amount);
  }

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    this.#beforeOp("memoryGuard");
    // Guest memory cannot be rolled back by any scheme, so a fault body
    // cannot restore the pre-instruction state once the instruction stored.
    assert(!this.#wroteMemory, "a memory guard cannot follow a memory write in the same instruction");

    const addressId = address;

    for (const action of memoryGuardActions(
      this.#values,
      addressId,
      byteLength,
      { kind: "data", access },
      this.#state.flushesForPath("fault")
    )) {
      this.#emitAction(action);
    }
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
    return valueFromId(this.#values.compare(width, operator, a, b));
  }

  readFlag(flag: X86Flag): Value {
    this.#beforeOp("readFlag");
    if (!isX86StatusFlag(flag)) {
      return valueFromId(this.#state.flags.read(flag));
    }

    return valueFromId(this.#state.statusFlags.read(flag));
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    this.#beforeOp("writeFlag");
    if (isX86StatusFlag(flag)) {
      this.#state.statusFlags.write(flag, value);
      return;
    }

    this.#state.flags.write(flag, value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#beforeOp("writeStatusFlagsSource");
    this.#state.statusFlags.writeSource(source);
  }

  condition(cc: ConditionCode): Value {
    this.#beforeOp("condition");
    return valueFromId(this.#state.statusFlags.condition(cc));
  }

  jump(target: TargetInput): void {
    this.#beforeOp("jump");
    this.#state.instructionCount.increment();
    this.#state.eip.write(target);
    this.#blockEnd = "jump";
    this.#terminated = true;
  }

  jumpIf(condition: ValueInput, target: TargetInput): void {
    this.#beforeOp("jumpIf");
    this.#state.instructionCount.increment();
    this.#state.eip.write(this.#location().nextEip());

    const conditionId = condition;
    const targetId = target;

    this.#emitAction({
      kind: "if",
      condition: conditionId,
      thenBody: this.#earlyDispatchBody(targetId)
    });
    this.#terminated = true;
  }

  // Opens a loop: the declared channels become loop-carried cells
  // living in locals while the body runs. The loop itself falls through;
  // instruction completion remains with the surrounding semantic template.
  loop(options: LoopOptions): void {
    this.#beforeOp("loop");
    assert(this.#activeLoop === undefined, "nested loops are unsupported");

    const loop = LoopBuilder.begin({
      values: this.#values,
      state: this.#state,
      emitParentAction: (action) => this.#actions.push(action)
    }, options);

    this.#activeLoop = loop;

    let exitValues: readonly ValueId[];

    try {
      const loopBuilder = new LoopSemanticsBuilderImpl({
        host: this,
        state: this.#state,
        scope: loop.scope,
        binding: (index) => this.#binding(index)
      });

      exitValues = loop.emitContinue(options.body(loopBuilder));
    } finally {
      this.#activeLoop = undefined;
    }
    assert(!this.#terminated, "a loop body must not terminate the instruction");

    loop.close(options.enter, exitValues);
  }

  cpuExceptionIf(condition: ValueInput, exception: CpuException<ValueInput>): void {
    this.#beforeOp("cpuExceptionIf");
    assert(!this.#wroteMemory, "a CPU exception guard cannot follow a memory write in the same instruction");

    this.#emitAction({
      kind: "if",
      condition,
      hint: "unlikely",
      thenBody: this.#terminatingBody(
        { kind: "exit", exit: { class: "cpuException", exception } },
        this.#state.flushesForPath("fault")
      )
    });
  }

  // A trap resumes at the next instruction with all state observable.
  hostTrap(vector: ValueInput): void {
    this.#beforeOp("hostTrap");
    this.#state.instructionCount.increment();

    const vectorId = vector;

    this.#state.eip.write(this.#location().nextEip());
    this.#actions.push(...this.#state.flushesForPath("completed"));
    this.#actions.push({
      kind: "finish",
      finish: { kind: "exit", exit: { class: "host", reason: "hostTrap", payload: vectorId } }
    });
    this.#blockEnd = "terminated";
    this.#terminated = true;
  }

  // The taken path is a completed trap; the untaken path is the ordinary
  // fallthrough for this instruction and may continue into the next one.
  hostTrapIf(condition: ValueInput, vector: ValueInput): void {
    this.#beforeOp("hostTrapIf");
    this.#state.instructionCount.increment();

    const vectorId = vector;

    this.#state.eip.write(this.#location().nextEip());
    this.#actions.push({
      kind: "if",
      condition,
      hint: "unlikely",
      thenBody: this.#terminatingBody(
        { kind: "exit", exit: { class: "host", reason: "hostTrap", payload: vectorId } },
        this.#state.flushesForPath("completed")
      )
    });
    this.#terminated = true;
  }

  #earlyDispatchBody(target: TargetInput): Body {
    return this.#terminatingBody(
      { kind: "dispatch", targetEip: target },
      this.#state.flushesForCompletedDispatch()
    );
  }

  #terminatingBody(
    terminator: Finish,
    actions: readonly Action[]
  ): Body {
    return {
      actions: [
        ...actions,
        { kind: "finish", finish: terminator }
      ]
    };
  }

  #terminate(finish: Finish, actions: readonly Action[]): void {
    this.#actions.push(...actions);
    this.#actions.push({ kind: "finish", finish });
    this.#blockEnd = "terminated";
    this.#terminated = true;
  }

  // The action sink. The active loop builder owns body action routing
  // and invariant read hoisting while its callback runs.
  #emitAction(action: Action): void {
    const loop = this.#activeLoop;

    if (loop === undefined) {
      this.#actions.push(action);
      return;
    }

    loop.emitAction(action);
  }

  #dynamicGprSlot(binding: RegDynamicOperandBinding, accessWidth: OperandWidth): GprDynamicSlot {
    return {
      kind: "gprDynamic",
      index: this.#values.external(binding.index),
      byteLength: dynamicGprByteLength[accessWidth]
    };
  }

  #writeSegmentSelector(
    binding: SegmentOperandBinding | SegmentDynamicOperandBinding,
    value: ValueInput,
    accessWidth: OperandWidth
  ): void {
    assert(accessWidth === 16, `${accessWidth}-bit set to a segment selector`);
    this.#state.segments.writeSelector(binding, value);
  }

  #readGuestMemory(address: ValueId, width: OperandWidth, options: GetOptions): ValueId {
    // Sign-extension is meaningful only below the word, as in pending reads.
    const signed = options.signed === true && width !== 32;
    const output = this.#values.addActionOutput(memoryReadBounds(width, signed));

    this.#emitAction(
      signed
        ? { kind: "op", output, op: { kind: "memory.read", address, width, signed: true } }
        : { kind: "op", output, op: { kind: "memory.read", address, width } }
    );
    return output;
  }

  #writeGuestMemory(address: ValueId, value: ValueInput, width: OperandWidth): void {
    this.#wroteMemory = true;
    this.#emitAction({ kind: "op", op: { kind: "memory.write", address, value, width } });
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
        return this.#memSegmentLinearAddress(binding.segment, this.#operandAddress(index));
      case "memStatic":
        return this.#memSegmentLinearAddress(binding.segment, this.#operandAddress(index));
      case "memDynamic":
        return this.#memSegmentLinearAddress(binding.segment, this.#operandAddress(index));
    }
  }

  #dynamicAddress(binding: MemDynamicOperandBinding): ValueId {
    const base = this.#state.gpr.readDynamic({
      kind: "gprDynamic",
      index: this.#values.external(binding.base),
      byteLength: 4
    });

    return this.#values.binary("add", base, this.#values.external(binding.offset));
  }

  #effectiveAddress(ea: EffectiveAddressTerms): ValueId {
    let address: ValueId | undefined;

    if (ea.base !== undefined) {
      address = this.#state.gpr.read(ea.base);
    }

    if (ea.index !== undefined) {
      const index = this.#state.gpr.read(ea.index);
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

    return this.#values.binary("add", this.#state.segments.readBase(segment), offset);
  }

  #memSegmentLinearAddress(segment: MemSegmentBinding, offset: ValueId): ValueId {
    switch (segment.kind) {
      case "none":
        return offset;
      case "static":
        return this.#linearAddress(segment.reg, offset);
      case "dynamic":
        return this.#dynamicSegmentLinearAddress(segment.value, offset);
    }
  }

  #dynamicSegmentLinearAddress(segment: ExternalValueId, offset: ValueId): ValueId {
    return this.#values.binary("add", this.#state.segments.readDynamicBase(this.#values.external(segment)), offset);
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
