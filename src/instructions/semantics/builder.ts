import type { ConditionCode } from "#core/flags/conditions.js";
import type { CpuException } from "#core/exceptions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { X86Flag } from "#core/flags/definitions.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { VariableRef } from "#compiler/ir/variable.js";
import type {
  MemoryAccess,
  MemoryDataAccessIntent
} from "#memory/types.js";
import type { OperandWidth, RegName, SegmentRegister } from "#core/types.js";
import type {
  MemRef,
  OperandInput,
  OperandRef,
  RegRef,
  SegmentRef,
  StorageInput,
  TargetInput,
  Value,
  ValueInput
} from "./refs.js";

export type SemanticBranchHint = "unlikely" | "likely";

export type SemanticOperandMemoryOptions = Readonly<{
  addressOffset?: () => ValueInput;
  width?: OperandWidth;
}>;

export type SemanticReadOptions = Readonly<{
  width: OperandWidth;
  signed?: boolean;
  memory?: SemanticOperandMemoryOptions;
}>;

export type SemanticWriteOptions = Readonly<{
  width: OperandWidth;
  memory?: SemanticOperandMemoryOptions;
}>;

// A resolved destination can cross into structured control. The consuming
// semantic region is explicit so its read or write lands in that region while
// retaining the original range check and MemoryAccess metadata.
export interface SemanticUpdate {
  read(region: SemanticOps): Value;
  write(region: SemanticOps, value: ValueInput): void;
}

export type AccessFault = Readonly<{
  condition: Value;
  exception: CpuException<Value>;
}>;

export type AccessResolution<
  TIntent extends MemoryDataAccessIntent = MemoryDataAccessIntent
> = Readonly<{
  access: MemoryAccess<TIntent>;
  fault: AccessFault;
}>;

export type SemanticMemoryAccessOptions<
  TIntent extends MemoryDataAccessIntent
> = Readonly<{
  reference: MemRef;
  byteLength: ValueInput;
  intent: TIntent;
}>;

export type SemanticMemoryReadOptions = Readonly<{
  width: OperandWidth;
  signed?: boolean;
}>;

export type SemanticMemoryWriteOptions = Readonly<{
  width: OperandWidth;
  value: ValueInput;
}>;

export type SemanticMemoryLoadOptions = SemanticMemoryReadOptions & Readonly<{
  byteOffset?: ValueInput;
}>;

export type SemanticMemoryStoreOptions = SemanticMemoryWriteOptions & Readonly<{
  byteOffset?: ValueInput;
}>;

export interface SemanticMemoryOps {
  reference(segment: SegmentRegister, offset: ValueInput): MemRef;
  operand(operand: OperandInput, addressOffset?: ValueInput): MemRef;
  // Guards a reusable range without transferring bytes.
  guard<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): MemoryAccess<TIntent>;
  // Resolution is non-terminating; its caller owns fault selection.
  resolve<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): AccessResolution<TIntent>;
  read(reference: MemRef, options: SemanticMemoryReadOptions): Value;
  write(reference: MemRef, options: SemanticMemoryWriteOptions): void;
  // Loads and stores consume an existing access without selecting its fault.
  load(access: MemoryAccess, options: SemanticMemoryLoadOptions): Value;
  store(
    access: MemoryAccess<"write">,
    options: SemanticMemoryStoreOptions
  ): void;
}

export interface SemanticOps {
  readonly memory: SemanticMemoryOps;

  operand(index: number): OperandRef;
  reg(reg: RegName): RegRef;
  segment(operand: OperandInput): SegmentRef;

  read(source: StorageInput, options: SemanticReadOptions): Value;
  write(target: StorageInput, value: ValueInput, options: SemanticWriteOptions): void;
  update(target: StorageInput, options: SemanticWriteOptions): SemanticUpdate;
  address(operand: OperandInput): Value;

  readFlag(flag: X86Flag): Value;
  writeStatusFlagsSource(source: SimpleFlagSource): void;
  condition(cc: ConditionCode): Value;
  cpuException(exception: CpuException<ValueInput>): void;
}

export type SemanticVar = VariableRef<"i32">;
export type IfBody<TBuilder extends SemanticOps = SemanticsBuilder> = (
  builder: TBuilder,
  values: ValueBuilder
) => void;

export interface LoopSemanticsBuilder extends SemanticOps {
  if(
    condition: ValueInput,
    thenBuild: IfBody<LoopSemanticsBuilder>,
    hint?: SemanticBranchHint
  ): void;
  ifElse(
    condition: ValueInput,
    thenBuild: IfBody<LoopSemanticsBuilder>,
    elseBuild: IfBody<LoopSemanticsBuilder>,
    hint?: SemanticBranchHint
  ): void;
}

export type LoopBody = (
  builder: LoopSemanticsBuilder,
  values: ValueBuilder
) => ValueInput;

export type SemanticTemplate = (
  builder: SemanticsBuilder,
  values: ValueBuilder
) => void;

export interface SemanticsBuilder extends SemanticOps {
  currentEip(): Value;
  nextEip(): Value;

  var(seed: ValueInput): SemanticVar;
  writeFlag(flag: X86Flag, value: ValueInput): void;
  addInstructionCount(amount: ValueInput): void;

  if(condition: ValueInput, thenBuild: IfBody, hint?: SemanticBranchHint): void;
  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  jump(target: TargetInput): void;
  loop(body: LoopBody): void;
  hostTrap(vector: ValueInput): void;
}
