import { assert } from "#common/assert.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { CpuException } from "#x86/exceptions.js";
import { isX86StatusFlag, type X86Flag } from "#x86/flags.js";
import { operand, reg, toStorageRef } from "#x86/semantics/refs.js";
import type {
  SemanticsBuilder,
  GetOptions,
  IfBody,
  LoopBody,
  SemanticBranchHint,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticVar,
  SemanticTemplate,
  SimpleFlagSource
} from "#x86/semantics/builder.js";
import type {
  MemRef,
  MemoryAccess,
  MemoryAccessKind,
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
  ExternalValueId,
  OperandBinding,
  SegmentDynamicOperandBinding,
  SegmentOperandBinding
} from "./operands.js";
import { ControlEmitter, type IfOutcome } from "./builder/control.js";
import { LoopBuilder, type LoopMemoryOps } from "./builder/loop.js";
import { FinishEmitter } from "./builder/finish.js";
import { MemoryManager } from "./builder/memory.js";
import { OperandResolver } from "./builder/operands.js";
import { SemanticScopeStack } from "./builder/scope.js";
import { emitSegmentLoad, type SegmentMode } from "./builder/segments.js";
import { State } from "./builder/state/index.js";
import { StateWriteLog } from "./builder/state/write-log.js";
import { BodyBuilder } from "./body-builder.js";
import type { IrBlock } from "./block.js";
import { type StateChannel } from "./slots.js";
import { ValueTable } from "./value-table.js";
import type { ValueId } from "./values.js";

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
  readonly #scopes: SemanticScopeStack;
  readonly #state: State;
  readonly #operands: OperandResolver;
  readonly #control: ControlEmitter;
  readonly #finish: FinishEmitter;
  readonly #segmentMode: SegmentMode;
  readonly #memory: MemoryManager;
  #instructionLocation: InstructionLocationValues | undefined;
  #finished = false;
  // "terminated" means the root body already holds its terminator.
  #blockEnd: "fallthrough" | "jump" | "terminated" = "fallthrough";

  constructor(segmentMode: SegmentMode, stateWriteLog = new StateWriteLog()) {
    this.#body = new BodyBuilder(this.#values);
    this.#scopes = new SemanticScopeStack(this.#body);
    this.#state = new State(this.#values, () => this.#scopes.current.body, stateWriteLog);
    this.#operands = new OperandResolver(this.#values, this.#state, () => this.#scopes.current.operands);
    this.#memory = new MemoryManager({
      values: this.#values,
      scopes: this.#scopes,
      operands: this.#operands
    });
    this.#control = new ControlEmitter(this.#state, stateWriteLog, this.#scopes, this, this.#operands);
    this.#finish = new FinishEmitter(this.#state, this.#scopes);
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

    this.#scopes.root.reset();
    this.#operands.beginInstruction(bindings);
    this.#instructionLocation = this.#locationValues(location);
    this.#state.beginInstruction(this.#location().eip());

    this.#scopes.root.run(() => template(this, this.#values, this));

    if (!this.#scopes.root.isTerminated()) {
      this.#completeFallthrough();
    }

    // Cleared only on success: a template that throws leaves the instruction
    // in place with its partial pendings, poisoning further use.
    this.#instructionLocation = undefined;
    this.#operands.endInstruction();
  }

  isTerminated(): boolean {
    return this.#blockEnd !== "fallthrough";
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

  mem(segment: SegmentRegister, offset: ValueInput): MemRef {
    return this.#memory.mem(segment, offset);
  }

  operandMem(operandRef: OperandInput, displacement?: ValueInput): MemRef {
    return this.#memory.operandMem(operandRef, displacement);
  }

  var(seed: ValueInput): SemanticVar {
    const variable = this.#state.vars.create();

    this.#scopes.current.body.op({ kind: "var.write", variable: variable.index, value: seed });
    return variable;
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: GetOptions = {}): Value {
    const storage = toStorageRef(source);

    switch (storage.kind) {
      case "var":
        this.#state.vars.assertKnown(storage);
        return this.#scopes.current.body.opValue({ kind: "var.read", variable: storage.index });
      case "reg":
        return this.#state.gpr.read(storage.reg, accessWidth, options);
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
            assert(false, "memory operands must be resolved before reading");
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
      case "var":
        this.#state.vars.assertKnown(storage);
        this.#scopes.current.body.op({ kind: "var.write", variable: storage.index, value });
        return;
      case "reg":
        this.#state.gpr.write(storage.reg, value, accessWidth);
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
            assert(false, "memory operands must be resolved before writing");
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

  #completeFallthrough(): void {
    this.#completeInstruction(this.#location().nextEip());
    this.#dispatch("fallthrough");
  }

  addInstructionCount(amount: ValueInput): void {
    this.#state.instructionCount.add(amount);
  }

  memoryResolve<TIntent extends MemoryAccessKind>(
    memory: MemRef,
    byteLength: ValueInput,
    intent: TIntent
  ): MemoryAccess<TIntent> {
    return this.#memory.memoryResolve(memory, byteLength, intent);
  }

  memoryRead(
    access: MemoryAccess,
    byteOffset: ValueInput,
    width: OperandWidth,
    options: GetOptions = {}
  ): Value {
    return this.#memory.memoryRead(access, byteOffset, width, options);
  }

  memoryWrite(
    access: MemoryAccess<"write">,
    byteOffset: ValueInput,
    value: ValueInput,
    width: OperandWidth
  ): void {
    this.#memory.memoryWrite(access, byteOffset, value, width);
  }

  address(operandRef: OperandInput): Value {
    return this.#operands.address(operandRef.index);
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
    this.#dispatch("jump");
    this.#scopes.current.complete();
  }

  if(condition: ValueInput, thenBuild: IfBody, hint?: SemanticBranchHint): void {
    const outcome = this.#control.if(
      condition,
      () => thenBuild(this, this.#values),
      hint
    );

    this.#completeIf(outcome);
  }

  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void {
    const outcome = this.#control.ifElse(
      condition,
      () => thenBuild(this, this.#values),
      () => elseBuild(this, this.#values),
      hint
    );

    this.#completeIf(outcome);
  }

  #completeIf(outcome: IfOutcome): void {
    if (outcome === "completes") {
      this.#markTerminated();
      this.#endBlock("terminated");
      this.#scopes.current.complete();
    }
  }

  // Opens a loop: body-written channels become loop-carried cells living in
  // locals while the body runs. The loop itself falls through; instruction
  // completion remains with the surrounding semantic template.
  loop(body: LoopBody): void {
    const loop = LoopBuilder.begin({
      values: this.#values,
      state: this.#state,
      parent: this.#scopes.current.body
    }, this.#deriveLoopWrites(body));

    this.#control.runLoopBody(loop.body, body, (condition) => loop.emitContinue(condition));

    loop.close();
  }

  #deriveLoopWrites(body: LoopBody): readonly StateChannel[] {
    const writeLog = new StateWriteLog();
    const scratch = new IrBlockBuilderImpl(this.#segmentMode, writeLog);
    const scratchBody = new BodyBuilder(scratch.#values);
    const analysisMemory: LoopMemoryOps = {
      memoryRead: () => scratch.#values.addActionOutput(),
      memoryWrite: () => {}
    };

    scratch.#operands.beginInstruction(this.#operands.currentBindings());
    scratch.#state.beginInstruction(scratch.#values.const(0));
    // The replayed body holds var refs created on this builder.
    scratch.#state.vars.adopt(this.#state.vars.count);

    try {
      return writeLog.captureWrittenChannels(() => {
        scratch.#control.runLoopBody(scratchBody, body, (condition) => {
          scratch.#values.node(condition);
        }, analysisMemory);
      });
    } finally {
      scratch.#operands.endInstruction();
    }
  }

  cpuException(exception: CpuException<ValueInput>): void {
    assert(!this.#scopes.current.wroteMemory(), "a CPU exception cannot follow a memory write in the same instruction");
    this.#markTerminated();
    this.#finish.cpuException(exception);
    this.#endBlock("terminated");
    this.#scopes.current.complete();
  }

  // A trap resumes at the next instruction with all state observable.
  hostTrap(vector: ValueInput): void {
    this.#completeInstruction(this.#location().nextEip());
    this.#finish.hostTrap(vector);
    this.#endBlock("terminated");
    this.#scopes.current.complete();
  }

  #markTerminated(): void {
    this.#scopes.current.markTerminated();
  }

  #completeInstruction(target: ValueInput): void {
    this.#markTerminated();
    this.#state.instructionCount.increment();
    this.#state.eip.write(target);
  }

  // A completed flow ends in a dispatch: an arm's body finishes in place,
  // while the root body defers to finish() so the block can keep extending.
  #dispatch(rootEnd: "fallthrough" | "jump"): void {
    switch (this.#scopes.current.kind) {
      case "root":
        this.#endBlock(rootEnd);
        return;
      case "arm":
        this.#finish.dispatch(this.#scopes.current.body, this.#state.takeEipForDispatch());
        return;
      case "loop":
        assert(false, "a loop body must not dispatch");
    }
  }

  // Only the root flow's terminator ends the block; an arm's terminator is
  // local to its own body.
  #endBlock(end: "fallthrough" | "jump" | "terminated"): void {
    if (this.#scopes.current.kind === "root") {
      this.#blockEnd = end;
    }
  }

  #writeSegmentSelector(
    binding: SegmentOperandBinding | SegmentDynamicOperandBinding,
    value: ValueInput,
    accessWidth: OperandWidth
  ): void {
    assert(accessWidth === 16, `${accessWidth}-bit set to a segment selector`);
    assert(!this.#scopes.current.isTerminated(), "the semantic scope is already terminated");
    // Also what keeps segment reads hoistable out of loop bodies.
    assert(this.#scopes.current.kind !== "loop", "a segment load inside a loop body is unsupported");
    assert(this.#scopes.current.kind === "root", "a segment load inside a semantic if arm is unsupported");

    const outcome = emitSegmentLoad(this.#segmentMode, this.#values, this.#finish, binding, value);

    if (outcome === "terminated") {
      this.#markTerminated();
      this.#endBlock("terminated");
      this.#scopes.current.complete();
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
