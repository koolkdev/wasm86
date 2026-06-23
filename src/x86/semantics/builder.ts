import type { ConditionCode } from "#x86/conditions.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { CompareOperator } from "#x86/semantics/ops.js";
import type { OperandWidth, RegName } from "#x86/types.js";
import type {
  MemRef,
  OperandInput,
  OperandRef,
  RegRef,
  StorageInput,
  TargetInput,
  Value,
  ValueInput
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
  | Readonly<{ kind: "expr"; value: Value }>
  | Readonly<{ kind: "undef" }>;

export type GetOptions = Readonly<{
  signed?: boolean;
}>;

export type SemanticOperandInput = OperandRef;

export interface SemanticBuildContext {
  operandInfo(operand: SemanticOperandInput): SemanticOperandInfo;
}

export type SemanticTemplate = (builder: SemanticsBuilder, context: SemanticBuildContext) => void;

export interface SemanticsBuilder {
  operand(index: number): OperandRef;
  const32(value: number): Value;
  nextEip(): Value;
  reg(reg: RegName): RegRef;
  mem(address: ValueInput): MemRef;

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): Value;
  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void;
  memoryGuard(address: ValueInput, byteLength: number, access: MemoryAccessKind): void;
  address(operand: OperandInput): Value;

  i32Add(a: ValueInput, b: ValueInput): Value;
  i32Sub(a: ValueInput, b: ValueInput): Value;
  i32Xor(a: ValueInput, b: ValueInput): Value;
  i32Or(a: ValueInput, b: ValueInput): Value;
  i32And(a: ValueInput, b: ValueInput): Value;
  i32Shl(a: ValueInput, b: ValueInput): Value;
  i32ShrU(a: ValueInput, b: ValueInput): Value;
  i32Extend8S(value: ValueInput): Value;
  i32Extend16S(value: ValueInput): Value;
  i32Popcnt(value: ValueInput): Value;
  i32Select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value;
  project(width: OperandWidth, value: ValueInput): Value;
  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value;

  flagExpr(value: ValueInput): FlagWriteCell;
  flagUndef(): FlagWriteCell;
  readFlag(flag: X86Flag): Value;
  writeFlag(flag: X86Flag, value: ValueInput): void;
  writeFlags(write: FlagWriteInput): void;
  condition(cc: ConditionCode): Value;

  next(): void;
  jump(target: TargetInput): void;
  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void;
  hostTrap(vector: ValueInput): void;
}

export type FlagWriteInput = Readonly<{
  cells: Partial<Record<X86StatusFlag, FlagWriteCell>>;
  conditions?: Partial<Record<ConditionCode, ValueInput>>;
}>;
