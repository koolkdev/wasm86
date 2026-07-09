import type { ConditionCode } from "#x86/conditions.js";
import type { CpuException } from "#x86/exceptions.js";
import type { SimpleFlagSource as ArchitecturalSimpleFlagSource } from "#x86/flag-sources.js";
import type { X86Flag, X86StatusFlag } from "#x86/flags.js";
import type { Values } from "#ir/values.js";
import type { OperandWidth, RegName, SegmentRegister } from "#x86/types.js";
import type {
  MemRef,
  OperandInput,
  OperandRef,
  RegRef,
  StorageInput,
  TargetInput,
  VarRef,
  Value,
  ValueInput
} from "./refs.js";

export type MemoryAccessKind = "read" | "write";
export type SemanticBranchHint = "unlikely" | "likely";

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
  reg(reg: RegName): RegRef;
  mem(address: ValueInput): MemRef;

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): Value;
  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void;
  memoryGuard(address: ValueInput, byteLength: ValueInput, access: MemoryAccessKind): void;
  address(operand: OperandInput): Value;
  linearAddress(operand: OperandInput): Value;

  readFlag(flag: X86Flag): Value;
  writeStatusFlagsSource(source: SimpleFlagSource): void;
  condition(cc: ConditionCode): Value;
}

export interface LoopSemanticsBuilder extends SemanticOps {}

export type SemanticVar = VarRef;
export type LoopBody = (builder: LoopSemanticsBuilder, values: Values) => ValueInput;
export type IfBody = (builder: SemanticsBuilder, values: Values) => void;

export interface SemanticBuildContext {
  operandInfo(operand: SemanticOperandInput): SemanticOperandInfo;
}

export type SemanticTemplate = (
  builder: SemanticsBuilder,
  values: Values,
  context: SemanticBuildContext
) => void;

export interface SemanticsBuilder extends SemanticOps {
  currentEip(): Value;
  nextEip(): Value;

  var(seed: ValueInput): SemanticVar;
  writeFlag(flag: X86Flag, value: ValueInput): void;
  addInstructionCount(amount: ValueInput): void;

  jump(target: TargetInput): void;
  if(condition: ValueInput, thenBuild: IfBody, hint?: SemanticBranchHint): void;
  loop(body: LoopBody): void;
  cpuException(exception: CpuException<ValueInput>): void;
  hostTrap(vector: ValueInput): void;
}
