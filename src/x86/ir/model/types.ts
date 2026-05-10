import type { OperandWidth, Reg32 } from "#x86/isa/types.js";

export type VarId = number;

export type IrValueType = "i32";

export type VarRef = Readonly<{ kind: "var"; id: VarId }>;
export type IrConstValueRef = Readonly<{ kind: "const"; type: IrValueType; value: number }>;
export type NextEipRef = Readonly<{ kind: "nextEip" }>;
export type ValueRef = VarRef | IrConstValueRef | NextEipRef;

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: Reg32 }>;
export type MemRef = Readonly<{ kind: "mem"; address: ValueRef }>;
export type StorageRef = OperandRef | RegRef | MemRef;

export type TargetRef = ValueRef;

export type ConditionCode =
  | "O"
  | "NO"
  | "B"
  | "AE"
  | "E"
  | "NE"
  | "BE"
  | "A"
  | "S"
  | "NS"
  | "P"
  | "NP"
  | "L"
  | "GE"
  | "LE"
  | "G";

export type FlagProducerName = "add" | "sub" | "logic" | "inc" | "dec";
export type FlagMask = number;

export type IrFlagSetOp = Readonly<{
  op: "flags.set";
  producer: FlagProducerName;
  width?: OperandWidth;
  writtenMask: FlagMask;
  undefMask: FlagMask;
  inputs: Readonly<Record<string, ValueRef>>;
}>;

export type IrAluFlagsConditionOp = Readonly<{
  op: "aluFlags.condition";
  dst: VarRef;
  cc: ConditionCode;
}>;

export type IrBinaryOperator =
  | "add"
  | "sub"
  | "xor"
  | "or"
  | "and"
  | "shl"
  | "shr_u";

export type IrUnaryOperator =
  | "extend8_s"
  | "extend16_s";

export type IrBinaryValueOp = Readonly<{
  op: "value.binary";
  type: IrValueType;
  operator: IrBinaryOperator;
  dst: VarRef;
  a: ValueRef;
  b: ValueRef;
}>;

export type IrUnaryValueOp = Readonly<{
  op: "value.unary";
  type: IrValueType;
  operator: IrUnaryOperator;
  dst: VarRef;
  value: ValueRef;
}>;

export type IrSelectValueOp = Readonly<{
  op: "value.select";
  type: IrValueType;
  dst: VarRef;
  condition: ValueRef;
  whenTrue: ValueRef;
  whenFalse: ValueRef;
}>;

export type IrGetOptions = Readonly<{
  signed?: boolean;
}>;

export type IrOp =
  | Readonly<{ op: "get"; dst: VarRef; source: StorageRef; accessWidth?: OperandWidth; signed?: boolean }>
  | Readonly<{ op: "set"; target: StorageRef; value: ValueRef; accessWidth?: OperandWidth }>
  | Readonly<{ op: "address"; dst: VarRef; operand: OperandRef }>
  | Readonly<{ op: "value.const"; type: IrValueType; dst: VarRef; value: number }>
  | IrBinaryValueOp
  | IrUnaryValueOp
  | IrSelectValueOp
  | IrFlagSetOp
  | Readonly<{ op: "flags.materialize"; mask: FlagMask }>
  | Readonly<{ op: "flags.boundary"; mask: FlagMask }>
  | IrAluFlagsConditionOp
  | Readonly<{ op: "next" }>
  | Readonly<{ op: "jump"; target: TargetRef }>
  | Readonly<{ op: "conditionalJump"; condition: ValueRef; taken: TargetRef; notTaken: TargetRef }>
  | Readonly<{ op: "hostTrap"; vector: ValueRef }>;

export type IrBlock = readonly IrOp[];
export type SemanticTemplate = (builder: IrBuilder) => void;

export interface IrBuilder {
  operand(index: number): OperandRef;
  const32(value: number): IrConstValueRef;
  nextEip(): NextEipRef;
  reg(reg: Reg32): RegRef;
  mem(address: ValueInput): MemRef;

  get(source: StorageInput, accessWidth?: OperandWidth, options?: IrGetOptions): VarRef;
  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void;
  address(operand: OperandInput): VarRef;

  i32Add(a: ValueInput, b: ValueInput): VarRef;
  i32Sub(a: ValueInput, b: ValueInput): VarRef;
  i32Xor(a: ValueInput, b: ValueInput): VarRef;
  i32Or(a: ValueInput, b: ValueInput): VarRef;
  i32And(a: ValueInput, b: ValueInput): VarRef;
  i32Shl(a: ValueInput, b: ValueInput): VarRef;
  i32ShrU(a: ValueInput, b: ValueInput): VarRef;
  i32Extend8S(value: ValueInput): VarRef;
  i32Extend16S(value: ValueInput): VarRef;
  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): VarRef;

  setFlags(producer: FlagProducerName, inputs: Readonly<Record<string, ValueInput>>, width?: OperandWidth): void;
  materializeFlags(mask: FlagMask): void;
  boundaryFlags(mask: FlagMask): void;
  condition(cc: ConditionCode): VarRef;

  next(): void;
  jump(target: TargetInput): void;
  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void;
  hostTrap(vector: ValueInput): void;
}

export type OperandInput = OperandRef;
export type StorageInput = StorageRef;
export type ValueInput = ValueRef | number;
export type TargetInput = ValueInput;
