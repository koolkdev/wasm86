import type { OperandWidth, RegName } from "#x86/types.js";
import type { X86Flag } from "#x86/flags.js";

export type VarId = number;

export type IrValueType = "i32";

export type VarRef = Readonly<{ kind: "var"; id: VarId }>;
export type IrConstValueRef = Readonly<{ kind: "const"; type: IrValueType; value: number }>;
export type NextEipRef = Readonly<{ kind: "nextEip" }>;
export type ValueRef = VarRef | IrConstValueRef | NextEipRef;

export type OperandRef = Readonly<{ kind: "operand"; index: number }>;
export type RegRef = Readonly<{ kind: "reg"; reg: RegName }>;
export type MemRef = Readonly<{ kind: "mem"; address: ValueRef }>;
export type StorageRef = OperandRef | RegRef | MemRef;

export type TargetRef = ValueRef;

export type SemanticOperandStorageKind =
  | "reg"
  | "mem"
  | "regOrMem"
  | "imm"
  | "relTarget";

export type SemanticOperandInfo = Readonly<{
  storage: SemanticOperandStorageKind;
}>;

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

export type IrFlagsConditionOp = Readonly<{
  op: "flags.condition";
  dst: VarRef;
  cc: ConditionCode;
}>;

export type IrFlagWriteCell =
  | Readonly<{ kind: "expr"; value: ValueRef }>
  | Readonly<{ kind: "undef" }>;

export type IrFlagWrite = Readonly<{
  cells: Partial<Record<X86Flag, IrFlagWriteCell>>;
  conditions?: Partial<Record<ConditionCode, ValueRef>>;
}>;

export type IrFlagWriteOp = IrFlagWrite & Readonly<{
  op: "flags.write";
}>;

export type IrBinaryOperator =
  | "add"
  | "sub"
  | "xor"
  | "or"
  | "and"
  | "shl"
  | "shr_u";

export type IrCompareOperator =
  | "eq"
  | "ne"
  | "lt_u"
  | "le_u"
  | "gt_u"
  | "ge_u"
  | "lt_s"
  | "le_s"
  | "gt_s"
  | "ge_s";

export type IrUnaryOperator =
  | "extend8_s"
  | "extend16_s"
  | "popcnt";

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

export type IrProjectValueOp = Readonly<{
  op: "value.project";
  type: IrValueType;
  dst: VarRef;
  width: OperandWidth;
  value: ValueRef;
}>;

export type IrCompareValueOp = Readonly<{
  op: "value.compare";
  type: IrValueType;
  operator: IrCompareOperator;
  dst: VarRef;
  width: OperandWidth;
  a: ValueRef;
  b: ValueRef;
}>;

export type IrGetOptions = Readonly<{
  signed?: boolean;
}>;

export type IrMemoryAccessKind = "read" | "write";

export type IrMemoryGuardOp = Readonly<{
  op: "memory.guard";
  address: ValueRef;
  byteLength: number;
  access: IrMemoryAccessKind;
}>;

export type IrOp =
  | Readonly<{ op: "get"; dst: VarRef; source: StorageRef; accessWidth?: OperandWidth }>
  | Readonly<{ op: "set"; target: StorageRef; value: ValueRef; accessWidth?: OperandWidth }>
  | IrMemoryGuardOp
  | Readonly<{ op: "address"; dst: VarRef; operand: OperandRef }>
  | Readonly<{ op: "value.const"; type: IrValueType; dst: VarRef; value: number }>
  | IrBinaryValueOp
  | IrUnaryValueOp
  | IrSelectValueOp
  | IrProjectValueOp
  | IrCompareValueOp
  | IrFlagsConditionOp
  | IrFlagWriteOp
  | Readonly<{ op: "next" }>
  | Readonly<{ op: "jump"; target: TargetRef }>
  | Readonly<{ op: "conditionalJump"; condition: ValueRef; taken: TargetRef; notTaken: TargetRef }>
  | Readonly<{ op: "hostTrap"; vector: ValueRef }>;

export type IrBlock = readonly IrOp[];
export type SemanticOperandInput = number | OperandRef;

export interface SemanticBuildContext {
  operandInfo(operand: SemanticOperandInput): SemanticOperandInfo;
}

export type SemanticTemplate = (builder: IrBuilder, context: SemanticBuildContext) => void;

export interface IrBuilder {
  operand(index: number): OperandRef;
  const32(value: number): IrConstValueRef;
  nextEip(): NextEipRef;
  reg(reg: RegName): RegRef;
  mem(address: ValueInput): MemRef;

  get(source: StorageInput, accessWidth?: OperandWidth, options?: IrGetOptions): VarRef;
  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void;
  memoryGuard(address: ValueInput, byteLength: number, access: IrMemoryAccessKind): void;
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
  i32Popcnt(value: ValueInput): VarRef;
  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): VarRef;
  project(width: OperandWidth, value: ValueInput): VarRef;
  compare(width: OperandWidth, operator: IrCompareOperator, a: ValueInput, b: ValueInput): VarRef;

  flagExpr(value: ValueInput): IrFlagWriteCell;
  flagUndef(): IrFlagWriteCell;
  writeFlags(write: IrFlagWriteInput): void;
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
export type IrFlagWriteInput = Readonly<{
  cells: Partial<Record<X86Flag, IrFlagWriteCell>>;
  conditions?: Partial<Record<ConditionCode, ValueInput>>;
}>;
