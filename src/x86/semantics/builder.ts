import type { ConditionCode } from "#core/conditions.js";
import type { CpuException } from "#core/exceptions.js";
import type { SimpleFlagSource as ArchitecturalSimpleFlagSource } from "#core/flag-sources.js";
import type { X86Flag, X86StatusFlag } from "#core/flags.js";
import type { Values } from "#ir/values.js";
import type { OperandWidth, RegName, SegmentRegister } from "#core/types.js";
import type {
  MemRef,
  MemoryAccess,
  MemoryAccessKind,
  OperandInput,
  OperandRef,
  RegRef,
  StorageInput,
  TargetInput,
  VarRef,
  Value,
  ValueInput
} from "./refs.js";

export type SemanticBranchHint = "unlikely" | "likely";

export type SemanticOperandStorageKind =
  | "reg"
  | "mem"
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
  mem(segment: SegmentRegister, offset: ValueInput): MemRef;
  operandMem(operand: OperandInput, displacement?: ValueInput): MemRef;

  get(source: StorageInput, accessWidth?: OperandWidth, options?: GetOptions): Value;
  set(target: StorageInput, value: ValueInput, accessWidth?: OperandWidth): void;
  memoryResolve<TIntent extends MemoryAccessKind>(
    memory: MemRef,
    byteLength: ValueInput,
    intent: TIntent
  ): MemoryAccess<TIntent>;
  memoryRead(
    access: MemoryAccess,
    byteOffset: ValueInput,
    width: OperandWidth,
    options?: GetOptions
  ): Value;
  memoryWrite(
    access: MemoryAccess<"write">,
    byteOffset: ValueInput,
    value: ValueInput,
    width: OperandWidth
  ): void;
  address(operand: OperandInput): Value;

  readFlag(flag: X86Flag): Value;
  writeStatusFlagsSource(source: SimpleFlagSource): void;
  condition(cc: ConditionCode): Value;
  if(condition: ValueInput, thenBuild: IfBody, hint?: SemanticBranchHint): void;
  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  cpuException(exception: CpuException<ValueInput>): void;
}

export type { MemoryAccess, MemoryAccessKind } from "./refs.js";

export interface LoopSemanticsBuilder extends SemanticOps {}

export type SemanticVar = VarRef;
export type LoopBody = (builder: LoopSemanticsBuilder, values: Values) => ValueInput;
export type IfBody<TBuilder extends SemanticOps = SemanticsBuilder> = (
  builder: TBuilder,
  values: Values
) => void;

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
  loop(body: LoopBody): void;
  hostTrap(vector: ValueInput): void;
}
