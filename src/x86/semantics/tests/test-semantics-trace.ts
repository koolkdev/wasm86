import { isX86StatusFlag, x86StatusFlags, type X86Flag, type X86StatusFlag } from "#x86/flags.js";
import type { CpuException } from "#x86/exceptions.js";
import { mem, operand, reg } from "#x86/semantics/refs.js";
import type { ConditionCode } from "#x86/conditions.js";
import type {
  SemanticsBuilder,
  GetOptions,
  IfBody,
  LoopBody,
  LoopSemanticsBuilder,
  MemoryAccessKind,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticOperandStorageKind,
  SemanticTemplate,
  SimpleFlagSource,
  StatusFlagValues,
  Values
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
  #currentEipValue: Value | undefined;
  #nextEipValue: Value | undefined;
  #nextValueId = 0;
  #terminated = false;
  readonly values: Values = {
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

  mem(address: ValueInput): MemRef {
    return mem(address);
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

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    this.#emit(`guard ${access} ${this.#value(address)}:${byteLength}`);
  }

  address(operandRef: OperandInput): Value {
    const out = this.#alloc(`addr ${this.#storage(operandRef)}`);

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  linearAddress(operandRef: OperandInput): Value {
    return this.address(operandRef);
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

  next(): void {
    this.#emitTerminator("next");
  }

  jump(target: TargetInput): void {
    this.#emitTerminator(`jump ${this.#value(target)}`);
  }

  if(condition: ValueInput, thenBuild: IfBody): void {
    this.#emit(`if ${this.#value(condition)}`);
    const parentTerminated = this.#terminated;

    this.#terminated = false;
    try {
      thenBuild(this, this.values);
    } finally {
      this.#terminated = parentTerminated;
    }
    this.#emit("ifEnd");
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

  cpuExceptionIf(condition: ValueInput, exception: CpuException<ValueInput>): void {
    this.#emit(`cpuExceptionIf ${this.#value(condition)} ${exception.kind}`);
  }

  hostTrap(vector: ValueInput): void {
    this.#emitTerminator(`hostTrap ${this.#value(vector)}`);
  }

  finish(): SemanticTrace {
    if (!this.#terminated) {
      this.next();
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
      case "mem":
        return `mem(${this.#value(input.address)})`;
    }
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
