import type { OperandWidth, RegName } from "#x86/isa/types.js";
import { createIrVarAllocator, type IrVarAllocator } from "./vars.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import { irOpIsTerminator, type IrTerminatorOp } from "#x86/ir/model/op-semantics.js";
import {
  const32,
  mem,
  nextEip,
  operand,
  reg,
  toStorageRef,
  toTargetRef,
  toValueRef
} from "#x86/ir/model/refs.js";
import type {
  ConditionCode,
  IrCompareOperator,
  FlagProducerName,
  IrBinaryOperator,
  IrConstValueRef,
  MemRef,
  NextEipRef,
  OperandInput,
  OperandRef,
  RegRef,
  IrBuilder,
  IrGetOptions,
  IrMemoryAccessKind,
  IrOp,
  IrBlock,
  IrFlagWriteCell,
  IrFlagWriteInput,
  SemanticBuildContext,
  SemanticOperandInfo,
  SemanticOperandInput,
  StorageInput,
  TargetInput,
  IrUnaryOperator,
  VarRef,
  ValueInput
} from "#x86/ir/model/types.js";

export type IrBlockTerminator = IrTerminatorOp["op"];

export type IrEmitterOptions = Readonly<{
  ops?: IrOp[];
  allocator?: IrVarAllocator;
  resolveOperand?: (index: number) => OperandRef;
  operandInfo?: readonly (SemanticOperandInfo | undefined)[];
}>;

export class IrEmitter implements IrBuilder, SemanticBuildContext {
  readonly #ops: IrOp[];
  readonly #allocator: IrVarAllocator;
  readonly #resolveOperand: (index: number) => OperandRef;
  readonly #operandInfo: readonly (SemanticOperandInfo | undefined)[];
  readonly #semanticOperandIndexByOperandRef = new WeakMap<OperandRef, number>();
  #terminator: IrBlockTerminator | undefined;

  constructor(options: IrEmitterOptions = {}) {
    this.#ops = options.ops ?? [];
    this.#allocator = options.allocator ?? createIrVarAllocator();
    this.#resolveOperand = options.resolveOperand ?? operand;
    this.#operandInfo = options.operandInfo ?? [];
  }

  #allocVar(): VarRef {
    return this.#allocator.allocate();
  }

  #push(op: IrOp): void {
    if (this.#terminator !== undefined) {
      throw new Error(`cannot emit ${op.op} after IR terminator`);
    }

    this.#ops.push(op);

    if (irOpIsTerminator(op)) {
      this.#terminator = op.op;
    }
  }

  operand(index: number): OperandRef {
    const operandRef: OperandRef = { ...this.#resolveOperand(index) };

    this.#semanticOperandIndexByOperandRef.set(operandRef, index);
    return operandRef;
  }

  const32(value: number): IrConstValueRef {
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

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: IrGetOptions = {}): VarRef {
    const dst = this.#allocVar();
    const sourceRef = toStorageRef(source);

    this.#push({
      op: "get",
      dst,
      source: sourceRef,
      accessWidth,
      ...(options.signed === true ? { signed: true } : {})
    });
    return dst;
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    const targetRef = toStorageRef(target);

    this.#push({ op: "set", target: targetRef, value: toValueRef(value), accessWidth });
  }

  memoryGuard(address: ValueInput, byteLength: number, access: IrMemoryAccessKind): void {
    this.#push({ op: "memory.guard", address: toValueRef(address), byteLength, access });
  }

  operandInfo(operandInput: SemanticOperandInput): SemanticOperandInfo {
    const semanticIndex = typeof operandInput === "number"
      ? operandInput
      : this.#semanticOperandIndexForOperand(operandInput);
    const info = this.#operandInfo[semanticIndex];

    if (info === undefined) {
      throw new Error(`missing semantic operand metadata for operand ${semanticIndex}`);
    }

    return info;
  }

  #semanticOperandIndexForOperand(operandRef: OperandRef): number {
    return this.#semanticOperandIndexByOperandRef.get(operandRef) ?? operandRef.index;
  }

  address(operandInput: OperandInput): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "address", dst, operand: operandInput });
    return dst;
  }

  #binaryValue(operator: IrBinaryOperator, a: ValueInput, b: ValueInput): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "value.binary", type: "i32", operator, dst, a: toValueRef(a), b: toValueRef(b) });
    return dst;
  }

  #unaryValue(operator: IrUnaryOperator, value: ValueInput): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "value.unary", type: "i32", operator, dst, value: toValueRef(value) });
    return dst;
  }

  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): VarRef {
    const dst = this.#allocVar();

    this.#push({
      op: "value.select",
      type: "i32",
      dst,
      condition: toValueRef(condition),
      whenTrue: toValueRef(whenTrue),
      whenFalse: toValueRef(whenFalse)
    });
    return dst;
  }

  project(width: OperandWidth, value: ValueInput): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "value.project", type: "i32", dst, width, value: toValueRef(value) });
    return dst;
  }

  compare(width: OperandWidth, operator: IrCompareOperator, a: ValueInput, b: ValueInput): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "value.compare", type: "i32", operator, dst, width, a: toValueRef(a), b: toValueRef(b) });
    return dst;
  }

  i32Add(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("add", a, b);
  }

  i32Sub(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("sub", a, b);
  }

  i32Xor(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("xor", a, b);
  }

  i32Or(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("or", a, b);
  }

  i32And(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("and", a, b);
  }

  i32Shl(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("shl", a, b);
  }

  i32ShrU(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("shr_u", a, b);
  }

  i32Extend8S(value: ValueInput): VarRef {
    return this.#unaryValue("extend8_s", value);
  }

  i32Extend16S(value: ValueInput): VarRef {
    return this.#unaryValue("extend16_s", value);
  }

  i32Popcnt(value: ValueInput): VarRef {
    return this.#unaryValue("popcnt", value);
  }

  setFlags(producer: FlagProducerName, inputs: Readonly<Record<string, ValueInput>>, width?: OperandWidth): void {
    this.#push(
      createIrFlagSetOp(
        producer,
        Object.fromEntries(Object.entries(inputs).map(([name, value]) => [name, toValueRef(value)])),
        width
      )
    );
  }

  flagExpr(value: ValueInput): IrFlagWriteCell {
    return { kind: "expr", value: toValueRef(value) };
  }

  flagUndef(): IrFlagWriteCell {
    return { kind: "undef" };
  }

  writeFlags(write: IrFlagWriteInput): void {
    const cells: IrFlagWriteInput["cells"] = {};
    const op = {
      op: "flags.write",
      cells
    } as const;

    for (const [flag, cell] of Object.entries(write.cells) as [keyof typeof cells, IrFlagWriteCell][]) {
      cells[flag] = cell.kind === "expr"
        ? { kind: "expr", value: toValueRef(cell.value) }
        : { kind: "undef" };
    }

    if (write.conditions === undefined) {
      this.#push(op);
      return;
    }

    this.#push({
      ...op,
      conditions: Object.fromEntries(
        Object.entries(write.conditions).map(([cc, value]) => [cc, toValueRef(value)])
      )
    });
  }

  condition(cc: ConditionCode): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "flags.condition", dst, cc });
    return dst;
  }

  next(): void {
    this.#push({ op: "next" });
  }

  jump(target: TargetInput): void {
    this.#push({ op: "jump", target: toTargetRef(target) });
  }

  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void {
    this.#push({
      op: "conditionalJump",
      condition: toValueRef(condition),
      taken: toTargetRef(taken),
      notTaken: toTargetRef(notTaken)
    });
  }

  hostTrap(vector: ValueInput): void {
    this.#push({ op: "hostTrap", vector: toValueRef(vector) });
  }

  finish(): IrBlockTerminator {
    if (this.#terminator === undefined) {
      this.next();
    }

    if (this.#terminator === undefined) {
      throw new Error("IR block is missing a terminator");
    }

    return this.#terminator;
  }

  block(): IrBlock {
    this.finish();
    return [...this.#ops];
  }
}

export function irBlockTerminator(block: IrBlock): IrBlockTerminator {
  const terminator = block[block.length - 1];

  if (terminator === undefined || !irOpIsTerminator(terminator)) {
    throw new Error("IR block is missing a terminator");
  }

  return terminator.op;
}
