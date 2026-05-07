import type { OperandWidth, Reg32 } from "#x86/isa/types.js";
import { createIrFlagSetOp } from "#x86/ir/model/flags.js";
import { irOpIsTerminator, type IrTerminatorOp } from "#x86/ir/model/op-semantics.js";
import {
  const32,
  mem,
  nextEip,
  operand,
  reg,
  irVar,
  toStorageRef,
  toTargetRef,
  toValueRef
} from "#x86/ir/model/refs.js";
import type {
  ConditionCode,
  FlagMask,
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
  IrOp,
  IrBlock,
  StorageInput,
  TargetInput,
  IrUnaryOperator,
  VarRef,
  ValueInput
} from "#x86/ir/model/types.js";

export type IrBlockTerminator = IrTerminatorOp["op"];

export type IrEmitterOptions = Readonly<{
  ops?: IrOp[];
  allocateVar?: () => VarRef;
  resolveOperand?: (index: number) => OperandRef;
}>;

export class IrEmitter implements IrBuilder {
  readonly #ops: IrOp[];
  readonly #allocateVarOverride: (() => VarRef) | undefined;
  readonly #resolveOperand: (index: number) => OperandRef;
  #nextVarId = 0;
  #terminator: IrBlockTerminator | undefined;

  constructor(options: IrEmitterOptions = {}) {
    this.#ops = options.ops ?? [];
    this.#allocateVarOverride = options.allocateVar;
    this.#resolveOperand = options.resolveOperand ?? operand;
  }

  #allocVar(): VarRef {
    if (this.#allocateVarOverride !== undefined) {
      return this.#allocateVarOverride();
    }

    const id = this.#nextVarId;

    this.#nextVarId += 1;
    return irVar(id);
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
    return this.#resolveOperand(index);
  }

  const32(value: number): IrConstValueRef {
    return const32(value);
  }

  nextEip(): NextEipRef {
    return nextEip();
  }

  reg(regInput: Reg32): RegRef {
    return reg(regInput);
  }

  mem(address: ValueInput): MemRef {
    return mem(address);
  }

  get(source: StorageInput, accessWidth: OperandWidth = 32, options: IrGetOptions = {}): VarRef {
    const dst = this.#allocVar();

    this.#push({
      op: "get",
      dst,
      source: toStorageRef(source),
      accessWidth,
      ...(options.signed === true ? { signed: true } : {})
    });
    return dst;
  }

  set(target: StorageInput, value: ValueInput, accessWidth: OperandWidth = 32): void {
    this.#push({ op: "set", target: toStorageRef(target), value: toValueRef(value), accessWidth });
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

  i32ShrU(a: ValueInput, b: ValueInput): VarRef {
    return this.#binaryValue("shr_u", a, b);
  }

  i32Extend8S(value: ValueInput): VarRef {
    return this.#unaryValue("extend8_s", value);
  }

  i32Extend16S(value: ValueInput): VarRef {
    return this.#unaryValue("extend16_s", value);
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

  materializeFlags(mask: FlagMask): void {
    this.#push({ op: "flags.materialize", mask });
  }

  boundaryFlags(mask: FlagMask): void {
    this.#push({ op: "flags.boundary", mask });
  }

  condition(cc: ConditionCode): VarRef {
    const dst = this.#allocVar();

    this.#push({ op: "aluFlags.condition", dst, cc });
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
