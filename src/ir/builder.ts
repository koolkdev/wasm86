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
import type { OperandWidth, RegName } from "#x86/types.js";
import type {
  ExternalValueId,
  OperandBinding,
  SegmentDynamicOperandBinding,
  SegmentOperandBinding
} from "./operands.js";
import { ControlEmitter } from "./builder/control.js";
import { LoopBuilder, LoopSemanticsBuilderImpl } from "./builder/loop.js";
import { FinishEmitter } from "./builder/finish.js";
import { OperandResolver } from "./builder/operands.js";
import { emitSegmentLoad, type SegmentMode } from "./builder/segments.js";
import { State } from "./builder/state/index.js";
import { BodyBuilder } from "./body-builder.js";
import type { IrBlock } from "./block.js";
import {
  ValueTable,
  type ValueId
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

class IrBlockBuilderImpl implements SemanticsBuilder, SemanticBuildContext {
  readonly #values = new ValueTable();
  readonly #body: BodyBuilder;
  #current: BodyBuilder;
  readonly #state: State;
  readonly #operands: OperandResolver;
  readonly #control: ControlEmitter;
  readonly #finish: FinishEmitter;
  readonly #segmentMode: SegmentMode;
  #instructionLocation: InstructionLocationValues | undefined;
  #terminated = false;
  #finished = false;
  #wroteMemory = false;
  // "terminated" means the root body already holds its terminator.
  #blockEnd: "fallthrough" | "jump" | "terminated" = "fallthrough";

  constructor(segmentMode: SegmentMode) {
    this.#body = new BodyBuilder(this.#values);
    this.#current = this.#body;
    this.#state = new State(this.#values, () => this.#current);
    this.#operands = new OperandResolver(this.#values, this.#state);
    this.#control = new ControlEmitter(
      this.#state,
      () => this.#current,
      (body, build) => this.#withCurrentBody(body, build)
    );
    this.#finish = new FinishEmitter(this.#state, () => this.#current, this.#control);
    this.#segmentMode = segmentMode;
  }

  addInstruction(
    template: SemanticTemplate,
    bindings: readonly OperandBinding[],
    location: InstructionLocation
  ): void {
    assert(!this.#finished, "cannot add instructions to a finished IR block builder");
    assert(this.#blockEnd === "fallthrough", "cannot add instructions after a block terminator");
    assert(this.#instructionLocation === undefined, "IR block builder has an incomplete instruction");

    this.#operands.beginInstruction(bindings);
    this.#instructionLocation = this.#locationValues(location);
    this.#terminated = false;
    this.#wroteMemory = false;
    this.#state.beginInstruction(this.#location().eip());

    template(this, this.#values, this);

    if (!this.#terminated) {
      this.next();
    }

    // Cleared only on success: a template that throws leaves the instruction
    // in place with its partial pendings, poisoning further use.
    this.#instructionLocation = undefined;
    this.#operands.endInstruction();
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

        this.#finish.dispatch(this.#body, targetEip);
        break;
      case "terminated":
        break;
    }

    return {
      body: this.#body.build(),
      values: this.#values
    };
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    return this.#operands.operandInfo(operandInput);
  }

  operand(index: number): OperandRef {
    this.#operands.binding(index);
    return operand(index);
  }

  currentEip(): Value {
    return this.#location().eip();
  }

  nextEip(): Value {
    return this.#location().nextEip();
  }

  reg(regInput: RegName): RegRef {
    return reg(regInput);
  }

  mem(address: ValueInput): MemRef {
    return mem(address);
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: GetOptions = {}): Value {
    const storage = toStorageRef(source);

    switch (storage.kind) {
      case "reg":
        return this.#state.gpr.read(storage.reg, accessWidth, options);
      case "mem":
        return this.#readMemory(storage.address, accessWidth, options);
      case "operand": {
        const binding = this.#operands.binding(storage.index);

        switch (binding.kind) {
          case "imm":
            return this.#values.widthAdjusted(accessWidth, this.#values.const(binding.value), options.signed === true);
          case "immExternal":
            return this.#values.widthAdjusted(
              accessWidth,
              this.#values.external(binding.value),
              options.signed === true
            );
          case "reg":
            return this.#state.gpr.read(binding.channel, accessWidth, options);
          case "segment":
            return this.#state.segments.readSelector(binding.channel, accessWidth, options);
          case "mem":
          case "memStatic":
          case "memDynamic":
            return this.#readMemory(this.#operands.linearAddress(storage.index), accessWidth, options);
          case "regDynamic":
            return this.#state.gpr.readDynamic(this.#operands.dynamicGprSlot(binding, accessWidth), options);
          case "segmentDynamic":
            return this.#state.segments.readDynamicSelector(this.#values.external(binding.index), accessWidth, options);
        }
      }
    }
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    const storage = toStorageRef(target);

    switch (storage.kind) {
      case "reg":
        this.#state.gpr.write(storage.reg, value, accessWidth);
        return;
      case "mem":
        this.#writeMemory(storage.address, value, accessWidth);
        return;
      case "operand": {
        const binding = this.#operands.binding(storage.index);

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
            this.#writeMemory(this.#operands.linearAddress(storage.index), value, accessWidth);
            return;
          case "regDynamic":
            this.#state.gpr.writeDynamic(this.#operands.dynamicGprSlot(binding, accessWidth), value);
            return;
          case "imm":
          case "immExternal":
            throw notSupportedError(`set to ${binding.kind} operand binding`);
        }
      }
    }
  }

  next(): void {
    this.#completeInstruction(this.#location().nextEip());
  }

  addInstructionCount(amount: ValueInput): void {
    this.#state.instructionCount.add(amount);
  }

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    // Guest memory cannot be rolled back by any scheme, so a fault body
    // cannot restore the pre-instruction state once the instruction stored.
    assert(!this.#wroteMemory, "a memory guard cannot follow a memory write in the same instruction");
    this.#finish.guardIf(address, byteLength, access);
  }

  address(operandRef: OperandInput): Value {
    return this.#operands.address(operandRef.index);
  }

  linearAddress(operandRef: OperandInput): Value {
    return this.#operands.linearAddress(operandRef.index);
  }

  readFlag(flag: X86Flag): Value {
    if (!isX86StatusFlag(flag)) {
      return this.#state.flags.read(flag);
    }

    return this.#state.statusFlags.read(flag);
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    if (isX86StatusFlag(flag)) {
      this.#state.statusFlags.write(flag, value);
      return;
    }

    this.#state.flags.write(flag, value);
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#state.statusFlags.writeSource(source);
  }

  condition(cc: ConditionCode): Value {
    return this.#state.statusFlags.condition(cc);
  }

  jump(target: TargetInput): void {
    this.#completeInstruction(target);
    this.#blockEnd = "jump";
  }

  jumpIf(condition: ValueInput, target: TargetInput): void {
    this.#completeInstruction(this.#location().nextEip());
    this.#control.if(condition, (taken) => {
      // The dispatch target is the jump target, not the pending fallthrough eip.
      this.#state.takeEipForDispatch();
      this.#finish.dispatch(taken, target);
    });
  }

  // Opens a loop: the declared channels become loop-carried cells
  // living in locals while the body runs. The loop itself falls through;
  // instruction completion remains with the surrounding semantic template.
  loop(options: LoopOptions): void {
    assert(this.#current === this.#body, "nested loops are unsupported");

    const loop = LoopBuilder.begin({
      values: this.#values,
      state: this.#state,
      parent: this.#current
    }, options);

    this.#withCurrentBody(loop.body, () => {
      const loopBuilder = new LoopSemanticsBuilderImpl({
        host: this,
        state: this.#state,
        scope: loop.scope,
        operands: this.#operands
      });

      loop.emitContinue(options.body(loopBuilder, this.#values));
    });
    assert(!this.#terminated, "a loop body must not terminate the instruction");

    loop.close(options.enter);
  }

  cpuExceptionIf(condition: ValueInput, exception: CpuException<ValueInput>): void {
    assert(!this.#wroteMemory, "a CPU exception guard cannot follow a memory write in the same instruction");
    this.#finish.faultIf(condition, exception);
  }

  // A trap resumes at the next instruction with all state observable.
  hostTrap(vector: ValueInput): void {
    this.#completeInstruction(this.#location().nextEip());
    this.#finish.hostTrap(vector);
    this.#blockEnd = "terminated";
  }

  // The taken path is a completed trap; the untaken path is the ordinary
  // fallthrough for this instruction and may continue into the next one.
  hostTrapIf(condition: ValueInput, vector: ValueInput): void {
    this.#completeInstruction(this.#location().nextEip());
    this.#finish.hostTrapIf(condition, vector);
  }

  #completeInstruction(target: ValueInput): void {
    assert(!this.#terminated, "the instruction is already terminated");
    this.#state.instructionCount.increment();
    this.#state.eip.write(target);
    this.#terminated = true;
  }

  #readMemory(address: ValueId, width: OperandWidth, options: GetOptions): Value {
    const signed = options.signed === true && width !== 32;

    return this.#current.opValue(
      signed
        ? { kind: "memory.read", address, width, signed: true }
        : { kind: "memory.read", address, width }
    );
  }

  #writeMemory(address: ValueId, value: ValueInput, width: OperandWidth): void {
    this.#wroteMemory = true;
    this.#current.op({ kind: "memory.write", address, value, width });
  }

  #withCurrentBody(body: BodyBuilder, build: (body: BodyBuilder) => void): void {
    const parent = this.#current;

    this.#current = body;
    try {
      build(body);
    } finally {
      this.#current = parent;
    }
  }

  #writeSegmentSelector(
    binding: SegmentOperandBinding | SegmentDynamicOperandBinding,
    value: ValueInput,
    accessWidth: OperandWidth
  ): void {
    assert(accessWidth === 16, `${accessWidth}-bit set to a segment selector`);
    assert(!this.#terminated, "the instruction is already terminated");
    // Also what keeps segment reads hoistable out of loop bodies.
    assert(this.#current === this.#body, "a segment load inside a loop body is unsupported");

    const outcome = emitSegmentLoad(this.#segmentMode, this.#values, this.#finish, binding, value);

    if (outcome === "terminated") {
      this.#blockEnd = "terminated";
      this.#terminated = true;
    }
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

}

function notSupportedError(what: string): Error {
  return new Error(`${what} not supported by IR block builder yet`);
}
