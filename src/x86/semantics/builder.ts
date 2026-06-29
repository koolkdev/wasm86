import type { ConditionCode } from "#x86/conditions.js";
import type { SimpleFlagSource as ArchitecturalSimpleFlagSource } from "#x86/flag-sources.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import type { MemoryAccessKind } from "#x86/memory-access.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#x86/semantics/ops.js";
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

export type SimpleFlagSource = ArchitecturalSimpleFlagSource<ValueInput>;

export type StatusFlagValues = Readonly<Record<X86StatusFlag, ValueInput>>;

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
  linearAddress(operand: OperandInput): Value;

  binary(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value;
  unary(operator: UnaryOperator, value: ValueInput): Value;
  select(condition: ValueInput, whenTrue: ValueInput, whenFalse: ValueInput): Value;
  truncate(width: OperandWidth, value: ValueInput): Value;
  extend(width: OperandWidth, value: ValueInput, signed: boolean): Value;
  compare(width: OperandWidth, operator: CompareOperator, a: ValueInput, b: ValueInput): Value;
  binary64(operator: BinaryOperator, a: ValueInput, b: ValueInput): Value;
  compare64(operator: CompareOperator, a: ValueInput, b: ValueInput): Value;
  truncate64(width: OperandWidth, value: ValueInput): Value;
  extend64(width: OperandWidth, value: ValueInput, signed: boolean): Value;

  readFlag(flag: X86Flag): Value;
  writeFlag(flag: X86Flag, value: ValueInput): void;
  writeStatusFlagsSource(source: SimpleFlagSource): void;
  condition(cc: ConditionCode): Value;

  next(): void;
  jump(target: TargetInput): void;
  conditionalJump(condition: ValueInput, taken: TargetInput, notTaken: TargetInput): void;
  hostTrap(vector: ValueInput): void;
}
