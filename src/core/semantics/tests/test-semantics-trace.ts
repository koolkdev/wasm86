import { assert } from "#common/assert.js";
import { isX86StatusFlag, x86StatusFlags, type X86Flag, type X86StatusFlag } from "#core/flags/definitions.js";
import {
  pageFault,
  pageFaultErrorCode,
  type CpuException
} from "#core/exceptions.js";
import { operand, reg } from "#core/semantics/refs.js";
import type { ConditionCode } from "#core/flags/conditions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { StatusFlagValues } from "#core/flags/values.js";
import { CellRef } from "#compiler/refs/cell.js";
import { DynamicByteOriginRef } from "#compiler/ir/resource.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type {
  MemoryAccess,
  MemoryDataAccessIntent
} from "#memory/access.js";
import type {
  SemanticsBuilder,
  IfBody,
  LoopBody,
  LoopSemanticsBuilder,
  SemanticBranchHint,
  SemanticMemoryOps,
  SemanticReadOptions,
  SemanticUpdate,
  SemanticVar,
  SemanticTemplate,
  SemanticWriteOptions
} from "#core/semantics/builder.js";
import type {
  MemRef,
  OperandInput,
  OperandRef,
  RegRef,
  SegmentRef,
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

export type SemanticTraceOperandStorageKind = "reg" | "mem" | "imm" | "relTarget";

export type SemanticTraceOperandInfo = Readonly<{
  storage: SemanticTraceOperandStorageKind;
  segment?:
    | Readonly<{ kind: "static"; reg: SegmentRegister }>
    | Readonly<{ kind: "dynamic"; index: ValueInput }>;
}>;

export function buildSemanticTrace(
  template: SemanticTemplate,
  operandInfo: readonly SemanticTraceOperandInfo[] = []
): SemanticTrace {
  const builder = new TraceBuilder(operandInfo);

  template(builder, builder.values);
  return builder.finish();
}

export function operands(
  ...storage: SemanticTraceOperandStorageKind[]
): readonly SemanticTraceOperandInfo[] {
  return storage.map((entry) => ({ storage: entry }));
}

export function regOperands(count: number): readonly SemanticTraceOperandInfo[] {
  return Array.from({ length: count }, () => ({ storage: "reg" as const }));
}

export function segmentOperand(reg: SegmentRegister): SemanticTraceOperandInfo {
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

class TraceBuilder implements SemanticsBuilder, LoopSemanticsBuilder {
  readonly #events: string[] = [];
  readonly #defs: string[] = [];
  readonly #flagWrites: StatusFlagValues[] = [];
  readonly #pendingStatusFlags = new Map<X86StatusFlag, ValueInput>();
  readonly #operandInfo: readonly SemanticTraceOperandInfo[];
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

  constructor(operandInfo: readonly SemanticTraceOperandInfo[]) {
    this.#operandInfo = operandInfo;
  }

  operand(index: number): OperandRef {
    return operand(index);
  }

  segment(operandRef: OperandInput): SegmentRef {
    const segment = this.#operand(operandRef).segment;

    assert(segment !== undefined, "operand is not a segment register");
    return segment;
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

  readonly memory: SemanticMemoryOps = {
    reference: (segment, offset) => {
      const reference: MemRef = {
        segment: { kind: "static", reg: segment },
        offset
      };

      this.#memoryDescriptions.set(
        reference,
        `segment(${segment}, ${this.#value(offset)})`
      );
      return reference;
    },
    operand: (operandRef, addressOffset) => {
      const reference = this.#describedMemory(`operand(${this.#storage(operandRef)})`);

      return addressOffset === undefined
        ? reference
        : this.#describedMemory(
          `offset(${this.#memory(reference)}, ${this.#value(addressOffset)})`
        );
    },
    access: (options) => {
      const access = this.memory.resolve(options);

      this.#faultMemoryAccess(access);
      return access;
    },
    resolve: ({ reference, byteLength, intent }) => {
      const id = this.#nextMemoryAccessId++;
      const linearAddress = (-id - 1) as Value;

      this.#inlineValues.set(linearAddress, `r${id}`);
      const valid = this.#alloc(`valid(${this.#value(linearAddress)}.${intent})`);
      const faulted = this.#alloc(`not(${this.#value(valid)})`);
      const access: MemoryAccess<typeof intent> = {
        range: { start: linearAddress, byteLength },
        origin: new DynamicByteOriginRef(),
        faulted,
        fault: { address: linearAddress, intent }
      };

      this.#emit(
        `resolve ${this.#value(linearAddress)} = ${this.#memory(reference)}:${this.#value(byteLength)}`
      );
      return access;
    },
    read: (access, options) => {
      const byteOffset = options.byteOffset ?? this.values.const(0);
      const out = this.#alloc(
        `read ${this.#access(access)}+${this.#value(byteOffset)}:${options.width}${options.signed === true ? ":signed" : ""}`
      );

      this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
      return out;
    },
    write: (access, options) => {
      const byteOffset = options.byteOffset ?? this.values.const(0);

      this.#emit(
        `write ${this.#access(access)}+${this.#value(byteOffset)}:${options.width} <- ${this.#value(options.value)}`
      );
    }
  };

  var(seed: ValueInput): SemanticVar {
    const label = this.#nextCellLabel++;
    const variable = new CellRef("i32");

    this.#cellLabels.set(variable, label);
    this.#emit(`var ${this.#storage(variable)} <- ${this.#value(seed)}`);
    return variable;
  }

  read(source: StorageInput, options: SemanticReadOptions): Value {
    if (source.kind === "operand" && this.#operand(source).storage === "mem") {
      const width = options.memory?.width ?? options.width;
      const reference = this.memory.operand(source, options.memory?.addressOffset?.());
      const access = this.memory.access({
        reference,
        byteLength: this.values.const(width / 8),
        intent: "read"
      });

      return this.memory.read(
        access,
        options.signed === true
          ? { width, signed: true }
          : { width }
      );
    }

    const out = this.#alloc(
      `get ${this.#storage(source)}:${options.width}${options.signed === true ? ":signed" : ""}`
    );

    this.#emit(`${this.#value(out)} = ${this.#definition(out)}`);
    return out;
  }

  write(target: StorageInput, value: ValueInput, options: SemanticWriteOptions): void {
    this.update(target, options).write(this, value);
  }

  update(target: StorageInput, options: SemanticWriteOptions): SemanticUpdate {
    if (target.kind === "operand" && this.#operand(target).storage === "mem") {
      const width = options.memory?.width ?? options.width;
      const reference = this.memory.operand(target, options.memory?.addressOffset?.());
      const access = this.memory.access({
        reference,
        byteLength: this.values.const(width / 8),
        intent: "write"
      });

      return {
        read: (region) => region.memory.read(access, { width }),
        write: (region, value) => region.memory.write(access, { width, value })
      };
    }

    return {
      read: (region) => region.read(target, { width: options.width }),
      write: (_region, value) => {
        this.#emit(`set ${this.#storage(target)}:${options.width} <- ${this.#value(value)}`);
      }
    };
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
      const resolvedErrorCode = this.#inlineValues.get(exception.errorCode);

      if (resolvedAddress !== undefined && resolvedErrorCode !== undefined) {
        this.#emitTerminator(
          `cpuException ${exception.kind} ${resolvedAddress}.${
            resolvedErrorCode === `${pageFaultErrorCode("dataWrite")}`
              ? "write"
              : "read"
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

  #operand(operandRef: OperandRef): SemanticTraceOperandInfo {
    return this.#operandInfo[operandRef.index] ?? { storage: "reg" };
  }

  #faultMemoryAccess(access: MemoryAccess<MemoryDataAccessIntent>): void {
    this.if(
      access.faulted,
      (failure) => failure.cpuException(
        pageFault(
          access.fault.address,
          this.values.const(pageFaultErrorCode(
            access.fault.intent === "write" ? "dataWrite" : "dataRead"
          ))
        )
      ),
      "unlikely"
    );
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
    return `${this.#value(access.fault.address)}.${access.fault.intent}`;
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
