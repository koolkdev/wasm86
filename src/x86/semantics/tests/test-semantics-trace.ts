import { isX86StatusFlag, x86StatusFlags, type X86Flag, type X86StatusFlag } from "#x86/flags.js";
import { mem, operand, reg } from "#x86/semantics/refs.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { MemoryAccessKind } from "#x86/memory-access.js";
import type {
  SemanticsBuilder,
  GetOptions,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticOperandStorageKind,
  SemanticTemplate,
  SimpleFlagSource,
  StatusFlagValues
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

  template(builder, builder);
  return builder.finish();
}

export function operands(...storage: SemanticOperandStorageKind[]): readonly SemanticOperandInfo[] {
  return storage.map((entry) => ({ storage: entry }));
}

export function regOperands(count: number): readonly SemanticOperandInfo[] {
  return Array.from({ length: count }, () => ({ storage: "reg" as const }));
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

class TraceBuilder implements SemanticsBuilder, SemanticBuildContext {
  readonly #events: string[] = [];
  readonly #defs: string[] = [];
  readonly #flagWrites: StatusFlagValues[] = [];
  readonly #pendingStatusFlags = new Map<X86StatusFlag, ValueInput>();
  readonly #operandInfo: readonly SemanticOperandInfo[];
  readonly #constValues = new Map<number, Value>();
  readonly #inlineValues = new Map<Value, string>();
  readonly #displayValues = new Map<Value, number>();
  #nextEipValue: Value | undefined;
  #nextValueId = 0;
  #terminated = false;

  constructor(operandInfo: readonly SemanticOperandInfo[]) {
    this.#operandInfo = operandInfo;
  }

  operand(index: number): OperandRef {
    return operand(index);
  }

  const32(value: number): Value {
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

  binary(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    return this.#binary(operator, a, b);
  }

  unary(operator: UnaryOperator, value: ValueInput): Value {
    return this.#unary(operator, value);
  }

  binary64(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value {
    return this.#alloc(`${operator}64(${this.#value(a)}, ${this.#value(b)})`);
  }

  compare64(operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
    return this.#alloc(`cmp64.${operator}(${this.#value(a)}, ${this.#value(b)})`);
  }

  project64(width: OperandWidth, value: ValueInput): Value {
    return this.#alloc(`project64.${width}(${this.#value(value)})`);
  }

  extend64(width: OperandWidth, value: ValueInput): Value {
    return this.#alloc(`extend64.${width}(${this.#value(value)})`);
  }

  select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value {
    return this.#alloc(
      `select(${this.#value(condition)}, ${this.#value(whenTrue)}, ${this.#value(whenFalse)})`
    );
  }

  project(width: OperandWidth, value: ValueInput): Value {
    return this.#alloc(`project${width}(${this.#value(value)})`);
  }

  extend(width: OperandWidth, value: ValueInput): Value {
    return this.#alloc(`extend${width}(${this.#value(value)})`);
  }

  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value {
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

  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void {
    this.#emitTerminator(
      `branch ${this.#value(condition)} ? ${this.#value(taken)} : ${this.#value(notTaken)}`
    );
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
