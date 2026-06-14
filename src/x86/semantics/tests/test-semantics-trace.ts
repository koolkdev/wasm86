import { strictEqual } from "node:assert";

import { const32, mem, nextEip, operand, reg, toValueRef } from "#x86/semantics/refs.js";
import type { ConditionCode } from "#x86/conditions.js";
import type { MemoryAccessKind } from "#x86/memory-access.js";
import type {
  SemanticsBuilder,
  FlagWriteCell,
  FlagWriteInput,
  GetOptions,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  SemanticOperandStorageKind,
  SemanticTemplate
} from "#x86/semantics/builder.js";
import type {
  ConstValueRef,
  MemRef,
  NextEipRef,
  OperandInput,
  OperandRef,
  RegRef,
  StorageInput,
  TargetInput,
  ValueInput,
  ValueRef,
  VarRef
} from "#x86/semantics/refs.js";
import type { X86Flag } from "#x86/flags.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#x86/semantics/ops.js";

export type SemanticTrace = Readonly<{
  events: readonly string[];
  defs: readonly string[];
  flagWrites: readonly FlagWriteInput[];
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

export function flagCell(write: FlagWriteInput, flag: X86Flag): ValueRef {
  const cell = write.cells[flag];

  strictEqual(cell?.kind, "expr", `expected ${flag} expr cell`);
  return cell.value;
}

export function conditionValue(
  write: FlagWriteInput,
  cc: keyof NonNullable<FlagWriteInput["conditions"]>
): ValueInput {
  const value = write.conditions?.[cc];

  if (value === undefined) {
    throw new Error(`expected ${cc} condition`);
  }

  return value;
}

class TraceBuilder implements SemanticsBuilder, SemanticBuildContext {
  readonly #events: string[] = [];
  readonly #defs: string[] = [];
  readonly #flagWrites: FlagWriteInput[] = [];
  readonly #operandInfo: readonly SemanticOperandInfo[];
  #terminated = false;

  constructor(operandInfo: readonly SemanticOperandInfo[]) {
    this.#operandInfo = operandInfo;
  }

  operand(index: number): OperandRef {
    return operand(index);
  }

  const32(value: number): ConstValueRef {
    return const32(value);
  }

  nextEip(): NextEipRef {
    return nextEip();
  }

  reg(regInput: RegName): RegRef {
    return reg(regInput);
  }

  mem(address: ValueInput): MemRef {
    return mem(address);
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const index = typeof operandInput === "number" ? operandInput : operandInput.index;
    const info = this.#operandInfo[index];

    if (info === undefined) {
      throw new Error(`missing semantic operand metadata for operand ${index}`);
    }

    return info;
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: GetOptions = {}): VarRef {
    const out = this.#alloc(
      `get ${this.#storage(source)}:${accessWidth}${options.signed === true ? ":signed" : ""}`
    );

    this.#emit(`${this.#def(out)} = ${this.#defs[out.id]}`);
    return out;
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    this.#emit(`set ${this.#storage(target)}:${accessWidth} <- ${this.#value(value)}`);
  }

  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void {
    this.#emit(`guard ${access} ${this.#value(address)}:${byteLength}`);
  }

  address(operandRef: OperandInput): VarRef {
    const out = this.#alloc(`addr ${this.#storage(operandRef)}`);

    this.#emit(`${this.#def(out)} = ${this.#defs[out.id]}`);
    return out;
  }

  i32Add(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("add", a, b);
  }

  i32Sub(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("sub", a, b);
  }

  i32Xor(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("xor", a, b);
  }

  i32Or(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("or", a, b);
  }

  i32And(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("and", a, b);
  }

  i32Shl(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("shl", a, b);
  }

  i32ShrU(a: ValueInput, b: ValueInput): VarRef {
    return this.#binary("shr_u", a, b);
  }

  i32Extend8S(value: ValueInput): VarRef {
    return this.#unary("extend8_s", value);
  }

  i32Extend16S(value: ValueInput): VarRef {
    return this.#unary("extend16_s", value);
  }

  i32Popcnt(value: ValueInput): VarRef {
    return this.#unary("popcnt", value);
  }

  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): VarRef {
    return this.#alloc(
      `select(${this.#value(condition)}, ${this.#value(whenTrue)}, ${this.#value(whenFalse)})`
    );
  }

  project(width: OperandWidth, value: ValueInput): VarRef {
    return this.#alloc(`project${width}(${this.#value(value)})`);
  }

  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): VarRef {
    return this.#alloc(`cmp${width}.${operator}(${this.#value(a)}, ${this.#value(b)})`);
  }

  flagExpr(value: ValueInput): FlagWriteCell {
    return { kind: "expr", value: toValueRef(value) };
  }

  flagUndef(): FlagWriteCell {
    return { kind: "undef" };
  }

  writeFlags(write: FlagWriteInput): void {
    const cells: FlagWriteInput["cells"] = {};

    for (const [flag, cell] of Object.entries(write.cells) as [X86Flag, FlagWriteCell][]) {
      cells[flag] = cell.kind === "expr"
        ? { kind: "expr", value: toValueRef(cell.value) }
        : { kind: "undef" };
    }

    const copied: FlagWriteInput = write.conditions === undefined
      ? { cells }
      : {
          cells,
          conditions: Object.fromEntries(
            Object.entries(write.conditions).map(([cc, value]) => [cc, toValueRef(value)])
          )
        };

    this.#flagWrites.push(copied);
    this.#emit(`flags ${Object.keys(cells).sort().join(",")}`);
  }

  condition(cc: ConditionCode): VarRef {
    const out = this.#alloc(`condition ${cc}`);

    this.#emit(`${this.#def(out)} = ${this.#defs[out.id]}`);
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

  #binary(operator: BinaryOperator, a: ValueInput, b: ValueInput): VarRef {
    return this.#alloc(`${operator}(${this.#value(a)}, ${this.#value(b)})`);
  }

  #unary(operator: UnaryOperator, value: ValueInput): VarRef {
    return this.#alloc(`${operator}(${this.#value(value)})`);
  }

  #alloc(definition: string): VarRef {
    const out: VarRef = { kind: "var", id: this.#defs.length };

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
    const value = toValueRef(input);

    switch (value.kind) {
      case "const":
        return `${value.value}`;
      case "nextEip":
        return "nextEip";
      case "var":
        return this.#def(value);
    }
  }

  #definition(input: ValueInput): string {
    const value = toValueRef(input);

    if (value.kind !== "var") {
      return this.#value(value);
    }

    const definition = this.#defs[value.id];

    if (definition === undefined) {
      throw new Error(`missing definition for ${this.#def(value)}`);
    }

    return definition;
  }

  #def(value: VarRef): string {
    return `%${value.id}`;
  }
}
