import type { ConditionCode } from "#x86/conditions.js";
import type { CpuException } from "#x86/exceptions.js";
import type { SimpleFlagSource as ArchitecturalSimpleFlagSource } from "#x86/flag-sources.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import type { BinaryOperator, CompareOperator, UnaryOperator } from "#x86/semantics/ops.js";
import type { OperandWidth, RegName, SegmentRegister } from "#x86/types.js";
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

export type MemoryAccessKind = "read" | "write";

export type SemanticOperandStorageKind =
  | "reg"
  | "mem"
  | "regOrMem"
  | "imm"
  | "relTarget";

export type SemanticOperandInfo = Readonly<{
  storage: SemanticOperandStorageKind;
  segment?: SemanticSegmentOperandInfo;
}>;

export type SemanticSegmentOperandInfo =
  | Readonly<{ kind: "static"; reg: SegmentRegister }>
  | Readonly<{ kind: "dynamic"; index: ValueInput }>;

export type SimpleFlagSource = ArchitecturalSimpleFlagSource<ValueInput>;

export type StatusFlagValues = Readonly<Record<X86StatusFlag, ValueInput>>;

export type GetOptions = Readonly<{
  signed?: boolean;
}>;

export type SemanticOperandInput = OperandRef;

export interface SemanticOps {
  operand(index: number): OperandRef;
  const32(value: number): Value;
  const64(value: bigint): Value;
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
  writeStatusFlagsSource(source: SimpleFlagSource): void;
  condition(cc: ConditionCode): Value;
}

export interface LoopSemanticsBuilder extends SemanticOps {}

// A fused semantic loop's state declaration. State registers live in locals
// for the loop's extent and materialize on fault or loop exit.
export type LoopOptions = Readonly<{
  // Gate for entering the first iteration.
  enter: ValueInput;
  // Registers whose pending writes are carried locally and committed on exit.
  stateRegs?: readonly RegName[];
  // Carry lazy status-flag state through the loop.
  statusFlags?: boolean;
  // Emits one iteration and returns the back-edge predicate.
  body: (builder: LoopSemanticsBuilder) => ValueInput;
}>;

export interface SemanticBuildContext {
  operandInfo(operand: SemanticOperandInput): SemanticOperandInfo;
}

export type SemanticTemplate = (builder: SemanticsBuilder, context: SemanticBuildContext) => void;

export interface SemanticsBuilder extends SemanticOps {
  currentEip(): Value;
  nextEip(): Value;

  writeFlag(flag: X86Flag, value: ValueInput): void;
  addInstructionCount(amount: ValueInput): void;

  next(): void;
  jump(target: TargetInput): void;
  jumpIf(condition: ValueInput, target: TargetInput): void;
  loop(options: LoopOptions): void;
  cpuExceptionIf(condition: ValueInput, exception: CpuException<ValueInput>): void;
  hostTrap(vector: ValueInput): void;
  hostTrapIf(condition: ValueInput, vector: ValueInput): void;
}
