import type { ConditionCode } from "#core/flags/conditions.js";
import type { CpuException } from "#core/exceptions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { X86Flag } from "#core/flags/definitions.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";
import type { CellRef } from "#compiler/refs/cell.js";
import type {
  MemoryAccess,
  MemoryDataAccessIntent
} from "#memory/access.js";
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

export type SemanticMemoryAccessOptions<
  TIntent extends MemoryDataAccessIntent
> = Readonly<{
  reference: MemRef;
  byteLength: ValueInput;
  intent: TIntent;
}>;

export type SemanticMemoryReadOptions = Readonly<{
  width: OperandWidth;
  byteOffset?: ValueInput;
  signed?: boolean;
}>;

export type SemanticMemoryWriteOptions = Readonly<{
  width: OperandWidth;
  byteOffset?: ValueInput;
  value: ValueInput;
}>;

export interface SemanticMemoryOps {
  reference(segment: SegmentRegister, offset: ValueInput): MemRef;
  operand(operand: OperandInput, addressOffset?: ValueInput): MemRef;
  // Resolves and terminates the selected CPU-fault path without transferring
  // bytes. The returned access can be consumed zero or more times.
  access<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): MemoryAccess<TIntent>;
  // Raw resolution for callers that deliberately own failure control.
  resolve<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): MemoryAccess<TIntent>;
  read(access: MemoryAccess, options: SemanticMemoryReadOptions): Value;
  write(access: MemoryAccess<"write">, options: SemanticMemoryWriteOptions): void;
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
  if(condition: ValueInput, thenBuild: IfBody, hint?: SemanticBranchHint): void;
  ifElse(
    condition: ValueInput,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  cpuException(exception: CpuException<ValueInput>): void;
}

export interface LoopSemanticsBuilder extends SemanticOps {}

export type SemanticVar = CellRef<"i32">;
export type LoopBody = (builder: LoopSemanticsBuilder, values: ValueBuilder) => ValueInput;
export type IfBody<TBuilder extends SemanticOps = SemanticsBuilder> = (
  builder: TBuilder,
  values: ValueBuilder
) => void;

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

  jump(target: TargetInput): void;
  loop(body: LoopBody): void;
  hostTrap(vector: ValueInput): void;
}
