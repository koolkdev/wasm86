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

export type IrFlagWriteCell =
  | Readonly<{ kind: "expr"; value: ValueRef }>
  | Readonly<{ kind: "undef" }>;

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

export type IrGetOptions = Readonly<{
  signed?: boolean;
}>;

export type IrMemoryAccessKind = "read" | "write";

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
