import type { ConditionCode } from "#x86/conditions.js";
import type { X86Flag } from "#x86/flags.js";
import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { CompareOperator } from "#x86/semantics/ops.js";
import type { OperandWidth, RegName } from "#x86/types.js";
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
} from "./refs.js";

export type SemanticOperandStorageKind =
  | "reg"
  | "mem"
  | "regOrMem"
  | "imm"
  | "relTarget";

export type SemanticOperandInfo = Readonly<{
  storage: SemanticOperandStorageKind;
}>;

export type FlagWriteCell =
  | Readonly<{ kind: "expr"; value: ValueRef }>
  | Readonly<{ kind: "undef" }>;

export type GetOptions = Readonly<{
  signed?: boolean;
}>;

export type SemanticOperandInput = number | OperandRef;

export interface SemanticBuildContext {
  operandInfo(operand: SemanticOperandInput): SemanticOperandInfo;
}

export type SemanticTemplate = (builder: SemanticsBuilder, context: SemanticBuildContext) => void;

export interface SemanticsBuilder {
  operand(index: number): OperandRef;
  const32(value: number): ConstValueRef;
  nextEip(): NextEipRef;
  reg(reg: RegName): RegRef;
  mem(address: ValueInput): MemRef;

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): VarRef;
  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void;
  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void;
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
  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): VarRef;

  flagExpr(value: ValueInput): FlagWriteCell;
  flagUndef(): FlagWriteCell;
  writeFlags(write: FlagWriteInput): void;
  condition(cc: ConditionCode): VarRef;

  next(): void;
  jump(target: TargetInput): void;
  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void;
  hostTrap(vector: ValueInput): void;
}

export type FlagWriteInput = Readonly<{
  cells: Partial<Record<X86Flag, FlagWriteCell>>;
  conditions?: Partial<Record<ConditionCode, ValueInput>>;
}>;
