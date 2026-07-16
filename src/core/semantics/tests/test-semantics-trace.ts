import { isX86StatusFlag, x86StatusFlags, type X86Flag, type X86StatusFlag } from "#core/flags/definitions.js";
import { pageFaultErrorCode, type CpuException } from "#core/exceptions.js";
import { operand, reg } from "#core/semantics/refs.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import { CellRef } from "#compiler/refs/cell.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  SemanticsBuilder,
  GetOptions,
  IfBody,
  LoopBody,
  LoopSemanticsBuilder,
  MemoryAccessKind,
  SemanticBranchHint,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticOperandStorageKind,
  SemanticVar,
  SemanticTemplate,
  SimpleFlagSource,
  StatusFlagValues
} from "#core/semantics/builder.js";
import type {
  MemRef,
  MemoryAccess,
  OperandInput,
  OperandRef,
  RegRef,
  StorageInput,
  TargetInput,
  Value,
  ValueInput
} from "#core/semantics/refs.js";
import type { OperandWidth, RegName, SegmentRegister } from "#core/types.js";
import type { BinaryOperator } from "#compiler/ir/values/binary.js";
import type { CompareOperator } from "#compiler/ir/values/comparison.js";
import type { UnaryOperator } from "#compiler/ir/values/unary.js";

export type SemanticTrace = Readonly<{
  events: readonly string[];
  defs: readonly string[];
  flagWrites: readonly StatusFlagValues[];
  value(input: ValueInput): string;
  def(input: ValueInput): string;
}>;

export function buildSemanticTrace(
  template: SemanticTemplate,
  operandInfo: readonly SemanticOperandInfo[] = []
): SemanticTrace {
  const builder = new TraceBuilder(operandInfo);

  template(builder, builder.values, builder);
  return builder.finish();
}

export function operands(...storage: SemanticOperandStorageKind[]): readonly SemanticOperandInfo[] {
  return storage.map((entry) => ({ storage: entry }));
}

export function regOperands(count: number): readonly SemanticOperandInfo[] {
  return Array.from({ length: count }, () => ({ storage: "reg" as const }));
}

export function segmentOperand(reg: SegmentRegister): SemanticOperandInfo {
  return { storage: "reg", segment: { kind: "static", reg } };
}

export function flagCell(
  write: Partial<Record<X86StatusFlag, ValueInput>>,
  flag: X86StatusFlag
): ValueInput {
  const value = write[flag];

  if (value === undefined) {
    throw new Error(`expected ${flag} flag value`);
  }

  return value;
}

function statusFlagValues(flags: StatusFlagValues): StatusFlagValues {
  return {
    CF: flags.CF,
    PF: flags.PF,
    AF: flags.AF,
    ZF: flags.ZF,
    SF: flags.SF,
    OF: flags.OF
  };
}

class TraceBuilder implements SemanticsBuilder, LoopSemanticsBuilder, SemanticBuildContext {
  readonly #events: string[] = [];
  readonly #defs: string[] = [];
  readonly #flagWrites: StatusFlagValues[] = [];
  readonly #pendingStatusFlags = new Map<X86StatusFlag, ValueInput>();
  readonly #operandInfo: readonly SemanticOperandInfo[];
  readonly #constValues = new Map<number, Value>();
  readonly #const64Values = new Map<bigint, Value>();
  readonly #inlineValues = new Map<Value, string>();
  readonly #displayValues = new Map<Value, number>();
  readonly #memoryDescriptions = new WeakMap<MemRef, string>();
  readonly #cellLabels = new WeakMap<CellRef, number>();
  #nextCellLabel = 0;
  #nextMemoryAccessId = 0;
  #currentEipValue: Value | undefined;
  #nextEipValue: Value | undefined;
  #nextValueId = 0;
  #terminated = false;
  readonly values: ValueBuilder = {
    const: (value) => this.#const(value),
    const64: (value) => this.#const64(value),
    binary: (operator, a, b) => this.#binary(operator, a, b),
    unary: (operator, value) => this.#unary(operator, value),
    select: (condition, whenTrue, whenFalse) => this.#select(condition, whenTrue, whenFalse),
    truncate: (width, value) => this.#truncate(width, value),
    extend: (width, value, signed) => this.#extend(width, value, signed),
    compare: (width, operator, a, b) => this.#compare(width, operator, a, b),
    binary64: (operator, a, b) => this.#binary64(operator, a, b),
    compare64: (operator, a, b) => this.#compare64(operator, a, b),
    truncate64: (width, value) => this.#truncate64(width, value),
    extend64: (width, value, signed) => this.#extend64(width, value, signed)
  };

  constructor(operandInfo: readonly SemanticOperandInfo[]) {
    this.#operandInfo = operandInfo;
  }

  operand(index: number): OperandRef {
    return operand(index);
  }

  #const(value: number): Value {
    const canonical = value >>> 0;
    const existing = this.#constValues.get(canonical);

    if (existing !== undefined) {
      return existing;
    }

    const handle = this.#allocateValue();

    this.#constValues.set(canonical, handle);
    this.#inlineValues.set(handle, `${canonical}`);
    return handle;
  }

  #const64(value: bigint): Value {
    const canonical = BigInt.asUintN(64, value);
    const existing = this.#const64Values.get(canonical);

    if (existing !== undefined) {
      return existing;
    }

    const handle = this.#allocateValue();

    this.#const64Values.set(canonical, handle);
    this.#inlineValues.set(handle, `${canonical}`);
    return handle;
  }

  currentEip(): Value {
    if (this.#currentEipValue !== undefined) {
      return this.#currentEipValue;
    }

    const handle = this.#allocateValue();

    this.#currentEipValue = handle;
    this.#inlineValues.set(handle, "currentEip");
    return handle;
  }

  nextEip(): Value {
    if (this.#nextEipValue !== undefined) {
      return this.#nextEipValue;
    }

    const handle = this.#allocateValue();

    this.#nextEipValue = handle;
    this.#inlineValues.set(handle, "nextEip");
    return handle;
  }

  reg(regInput: RegName): RegRef {
    return reg(regInput);
  }

  mem(segment: SegmentRegister, offset: ValueInput): MemRef {
    const memory: MemRef = {
      segment: { kind: "static", reg: segment },
      offset
    };

    this.#memoryDescriptions.set(memory, `segment(${segment}, ${this.#value(offset)})`);
    return memory;
  }

  operandMem(operandRef: OperandInput, displacement?: ValueInput): MemRef {
    const memory = this.#describedMemory(`operand(${this.#storage(operandRef)})`);

    return displacement === undefined
      ? memory
      : this.#describedMemory(`offset(${this.#memory(memory)}, ${this.#value(displacement)})`);
  }

  var(seed: ValueInput): SemanticVar {
    const label = this.#nextCellLabel++;
    const variable = new CellRef("i32");

    this.#cellLabels.set(variable, label);
    this.#emit(`var ${this.#storage(variable)} <- ${this.#value(seed)}`);
    return variable;
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const index = operandInput.index;
    const info = this.#operandInfo[index];

    if (info === undefined) {
      throw new Error(`missing semantic operand metadata for operand ${index}`);
    }

    return info;
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: GetOptions = {}): Value {
    const out = this.#alloc(
      `get ${this.#storage(source)}:${accessWidth}${options.signed === true ? ":signed" : ""}`
    );

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    this.#emit(`set ${this.#storage(target)}:${accessWidth} <- ${this.#value(value)}`);
  }

  memoryResolve<TIntent extends MemoryAccessKind>(
    memory: MemRef,
    byteLength: ValueInput,
    intent: TIntent
  ): MemoryAccess<TIntent> {
    const id = this.#nextMemoryAccessId++;
    const linearAddress = (-id - 1) as Value;

    this.#inlineValues.set(linearAddress, `r${id}`);
    const valid = this.#alloc(`valid(${this.#value(linearAddress)}.${intent})`);
    const invalid = this.#alloc(`not(${this.#value(valid)})`);
    const access: MemoryAccess<TIntent> = {
      kind: "memoryAccess",
      linearAddress,
      byteLength,
      invalid,
      intent
    };

    this.#emit(
      `resolve ${this.#value(linearAddress)} = ${this.#memory(memory)}:${this.#value(byteLength)}`
    );
    return access;
  }

  memoryRead(
    access: MemoryAccess,
    byteOffset: ValueInput,
    width: OperandWidth,
    options: GetOptions = {}
  ): Value {
    const out = this.#alloc(
      `read ${this.#access(access)}+${this.#value(byteOffset)}:${width}${options.signed === true ? ":signed" : ""}`
    );

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  memoryWrite(
    access: MemoryAccess<"write">,
    byteOffset: ValueInput,
    value: ValueInput,
    width: OperandWidth
  ): void {
    this.#emit(
      `write ${this.#access(access)}+${this.#value(byteOffset)}:${width} <- ${this.#value(value)}`
    );
  }

  address(operandRef: OperandInput): Value {
    const out = this.#alloc(`addr ${this.#storage(operandRef)}`);

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  #binary64(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    return this.#alloc(`${operator}64(${this.#value(a)}, ${this.#value(b)})`);
  }

  #compare64(operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    return this.#alloc(`cmp64.${operator}(${this.#value(a)}, ${this.#value(b)})`);
  }

  #truncate64(width: OperandWidth, value: ValueInput): Value {
    return this.#alloc(`truncate64.${width}(${this.#value(value)})`);
  }

  #extend64(width: OperandWidth, value: ValueInput, signed: boolean): Value {
    return this.#alloc(`extend64.${signed ? "s" : "u"}${width}(${this.#value(value)})`);
  }

  #select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value {
    return this.#alloc(
      `select(${this.#value(condition)}, ${this.#value(whenTrue)}, ${this.#value(whenFalse)})`
    );
  }

  #truncate(width: OperandWidth, value: ValueInput): Value {
    return this.#alloc(`truncate${width}(${this.#value(value)})`);
  }

  #extend(width: OperandWidth, value: ValueInput, signed: boolean): Value {
    return this.#alloc(`extend.${signed ? "s" : "u"}${width}(${this.#value(value)})`);
  }

  #compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    return this.#alloc(`cmp${width}.${operator}(${this.#value(a)}, ${this.#value(b)})`);
  }

  readFlag(flag: X86Flag): Value {
    const out = this.#alloc(`flag ${flag}`);

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  writeFlag(flag: X86Flag, value: ValueInput): void {
    this.#emit(`flag ${flag} <- ${this.#value(value)}`);

    if (isX86StatusFlag(flag)) {
      this.#pendingStatusFlags.set(flag, value);

      if (this.#pendingStatusFlags.size === x86StatusFlags.length) {
        this.#flagWrites.push(statusFlagValues(Object.fromEntries(this.#pendingStatusFlags) as StatusFlagValues));
        this.#pendingStatusFlags.clear();
      }
    } else {
      this.#pendingStatusFlags.clear();
    }
  }

  writeStatusFlagsSource(source: SimpleFlagSource): void {
    this.#emit(
      source.kind === "logic"
        ? `flagSource ${source.kind}:${source.width} result=${this.#value(source.result)}`
        : `flagSource ${source.kind}:${source.width} left=${this.#value(source.left)} right=${this.#value(source.right)} result=${this.#value(source.result)}`
    );
  }

  condition(cc: ConditionCode): Value {
    const out = this.#alloc(`condition ${cc}`);

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  jump(target: TargetInput): void {
    this.#emitTerminator(`jump ${this.#value(target)}`);
  }

  if(condition: ValueInput, thenBuild: IfBody, _hint?: SemanticBranchHint): void {
    this.#emit(`if ${this.#value(condition)}`);
    this.#traceIfArm(thenBuild);
    this.#emit("ifEnd");
  }

  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    _hint?: SemanticBranchHint
  ): void {
    this.#emit(`if ${this.#value(condition)}`);
    const thenCompletes = this.#traceIfArm(thenBuild);

    this.#emit("else");
    const elseCompletes = this.#traceIfArm(elseBuild);

    this.#emit("ifEnd");
    this.#terminated = thenCompletes && elseCompletes;
  }

  #traceIfArm(build: IfBody): boolean {
    const parentTerminated = this.#terminated;

    this.#terminated = false;
    try {
      build(this, this.values);
      return this.#terminated;
    } finally {
      this.#terminated = parentTerminated;
    }
  }

  loop(body: LoopBody): void {
    this.#emit("loop");
    const continueCondition = body(this, this.values);

    this.#emit(`loopContinue ${this.#value(continueCondition)}`);
    this.#emit("loopEnd");
  }

  addInstructionCount(amount: ValueInput): void {
    this.#emit(`addInstructionCount ${this.#value(amount)}`);
  }

  cpuException(exception: CpuException<ValueInput>): void {
    if (exception.kind === "PF") {
      const resolvedAddress = this.#inlineValues.get(exception.linearAddress);

      if (resolvedAddress !== undefined) {
        this.#emitTerminator(
          `cpuException ${exception.kind} ${resolvedAddress}.${
            exception.errorCode === pageFaultErrorCode("dataWrite") ? "write" : "read"
          }`
        );
        return;
      }
    }

    this.#emitTerminator(`cpuException ${exception.kind}`);
  }

  hostTrap(vector: ValueInput): void {
    this.#emitTerminator(`hostTrap ${this.#value(vector)}`);
  }

  finish(): SemanticTrace {
    if (!this.#terminated) {
      this.#emitTerminator("next");
    }

    return {
      events: this.#events,
      defs: this.#defs,
      flagWrites: this.#flagWrites,
      value: (input) => this.#value(input),
      def: (input) => this.#definition(input)
    };
  }

  #binary(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    return this.#alloc(`${operator}(${this.#value(a)}, ${this.#value(b)})`);
  }

  #unary(operator: UnaryOperator, value: ValueInput): Value {
    return this.#alloc(`${operator}(${this.#value(value)})`);
  }

  #alloc(definition: string): Value {
    const out = this.#allocateValue();

    this.#displayValues.set(out, this.#defs.length);
    this.#defs.push(definition);
    return out;
  }

  #emit(event: string): void {
    if (this.#terminated) {
      throw new Error(`cannot emit ${event} after terminator`);
    }

    this.#events.push(event);
  }

  #emitTerminator(event: string): void {
    this.#emit(event);
    this.#terminated = true;
  }

  #storage(input: StorageInput): string {
    switch (input.kind) {
      case "operand":
        return `op${input.index}`;
      case "reg":
        return input.reg;
      case "cell": {
        const label = this.#cellLabels.get(input);

        if (label === undefined) {
          throw new Error("unknown semantic var cell");
        }
        return `var${label}`;
      }
    }
  }

  #describedMemory(description: string): MemRef {
    // Keep the trace description in the side table so operand-derived refs do
    // not manufacture value nodes.
    const memory: MemRef = {
      segment: { kind: "static", reg: "ds" },
      offset: 0 as Value
    };

    this.#memoryDescriptions.set(memory, description);
    return memory;
  }

  #memory(memory: MemRef): string {
    const described = this.#memoryDescriptions.get(memory);

    if (described !== undefined) {
      return described;
    }

    const segment = memory.segment.kind === "static"
      ? memory.segment.reg
      : `dynamic(${this.#value(memory.segment.index)})`;

    return `segment(${segment}, ${this.#value(memory.offset)})`;
  }

  #access(access: MemoryAccess): string {
    return `${this.#value(access.linearAddress)}.${access.intent}`;
  }

  #value(input: ValueInput): string {
    const inline = this.#inlineValues.get(input);

    if (inline !== undefined) {
      return inline;
    }

    return `%${this.#display(input)}`;
  }

  #definition(input: ValueInput): string {
    const inline = this.#inlineValues.get(input);

    if (inline !== undefined) {
      return inline;
    }

    const definition = this.#defs[this.#display(input)];

    if (definition === undefined) {
      throw new Error(`missing definition for ${this.#value(input)}`);
    }

    return definition;
  }

  #display(value: Value): number {
    const display = this.#displayValues.get(value);

    if (display === undefined) {
      throw new Error(`unknown value ${value}`);
    }

    return display;
  }

  #allocateValue(): Value {
    const handle = this.#nextValueId as Value;

    this.#nextValueId += 1;
    return handle;
  }
}
