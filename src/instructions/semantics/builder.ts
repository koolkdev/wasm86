import type { ConditionCode } from "#core/flags/conditions.js";
import type { CpuException } from "#core/exceptions.js";
import type { SimpleFlagSource } from "#core/flags/lazy/sources.js";
import type { X86Flag } from "#core/flags/definitions.js";
import {
  type Integer,
  type BitValue,
  type I32Value,
  type TruncationTargets
} from "#compiler/function/values.js";
import type { MemoryDataAccessIntent, ResolvedMemoryAccess } from "#memory/types.js";
import type { OperandWidth, RegName, SegmentRegister } from "#core/types.js";
import type {
  MemRef,
  OperandRef,
  RegRef,
  RegRefForWidth,
  SemanticVar,
  SegmentRef,
  StorageRef
} from "./refs.js";

export type { SemanticVar } from "./refs.js";

export type SemanticBranchHint = "unlikely" | "likely";

export type SemanticReadOptions = Readonly<{
  addressOffset?: I32Value;
}>;

export type SemanticWriteOptions<Width extends OperandWidth> = SemanticReadOptions &
  Readonly<{
    memoryWidth?: TruncationTargets<Width> & OperandWidth;
  }>;

type SemanticUpdateDestination =
  | Readonly<{ kind: "storage"; reference: StorageRef }>
  | Readonly<{ kind: "memory"; access: ResolvedMemoryAccess<"write"> }>;

// An update resolves its writable destination once. The consuming builder
// selects the region where each later read or write is emitted.
export type SemanticUpdate<Width extends OperandWidth> = Readonly<{
  kind: "update";
  width: Width;
  destination: SemanticUpdateDestination;
}>;

export type AccessFault = Readonly<{
  condition: BitValue;
  exception: CpuException<I32Value>;
}>;

export type AccessResolution<TIntent extends MemoryDataAccessIntent = MemoryDataAccessIntent> =
  Readonly<{
    access: ResolvedMemoryAccess<TIntent>;
    fault: AccessFault;
  }>;

export type SemanticMemoryAccessOptions<TIntent extends MemoryDataAccessIntent> = Readonly<{
  reference: MemRef;
  byteLength: I32Value;
  intent: TIntent;
}>;

export interface SemanticMemoryOps {
  reference(segment: SegmentRegister, offset: I32Value): MemRef;
  operand(operand: OperandRef, addressOffset?: I32Value): MemRef;
  // Guards a reusable range without transferring bytes.
  guard<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): ResolvedMemoryAccess<TIntent>;
  // Resolution is non-terminating; its caller owns fault selection.
  resolve<TIntent extends MemoryDataAccessIntent>(
    options: SemanticMemoryAccessOptions<TIntent>
  ): AccessResolution<TIntent>;
  read<Width extends OperandWidth>(reference: MemRef, width: Width): Integer<Width>;
  write<Width extends OperandWidth>(reference: MemRef, value: Integer<Width>): void;
  // Loads and stores consume an existing access without selecting its fault.
  load<Width extends OperandWidth>(
    access: ResolvedMemoryAccess,
    width: Width,
    byteOffset?: I32Value
  ): Integer<Width>;
  store<Width extends OperandWidth>(
    access: ResolvedMemoryAccess<"write">,
    value: Integer<Width>,
    byteOffset?: I32Value
  ): void;
}

export interface SemanticOps {
  readonly memory: SemanticMemoryOps;

  operand(index: number): OperandRef;
  reg<Name extends RegName>(reg: Name): RegRef<Name>;
  segment(operand: OperandRef): SegmentRef;

  read(source: SemanticVar): I32Value;
  read<Width extends OperandWidth>(source: RegRefForWidth<Width>): Integer<Width>;
  read<Width extends OperandWidth>(source: SemanticUpdate<Width>): Integer<Width>;
  read<Width extends OperandWidth>(
    source: OperandRef,
    width: Width,
    options?: SemanticReadOptions
  ): Integer<Width>;
  write(target: SemanticVar, value: I32Value): void;
  write<Width extends OperandWidth>(
    target: RegRefForWidth<Width>,
    value: Integer<NoInfer<Width>>
  ): void;
  write<Width extends OperandWidth>(
    target: SemanticUpdate<Width>,
    value: Integer<NoInfer<Width>>
  ): void;
  write<Width extends OperandWidth>(
    target: OperandRef,
    value: Integer<Width>,
    options?: SemanticWriteOptions<NoInfer<Width>>
  ): void;
  update(target: SemanticVar): SemanticUpdate<32>;
  update<Width extends OperandWidth>(target: RegRefForWidth<Width>): SemanticUpdate<Width>;
  update<Width extends OperandWidth>(
    target: OperandRef,
    width: Width,
    options?: SemanticReadOptions
  ): SemanticUpdate<Width>;
  address(operand: OperandRef): I32Value;

  readFlag(flag: X86Flag): BitValue;
  writeStatusFlagsSource<Width extends OperandWidth>(source: SimpleFlagSource<Width>): void;
  condition(cc: ConditionCode): BitValue;
  cpuException(exception: CpuException<I32Value>): void;
}

export type IfBody<TBuilder extends SemanticOps = SemanticsBuilder> = (builder: TBuilder) => void;

export interface LoopSemanticsBuilder extends SemanticOps {
  if(condition: BitValue, thenBuild: IfBody<LoopSemanticsBuilder>, hint?: SemanticBranchHint): void;
  ifElse(
    condition: BitValue,
    thenBuild: IfBody<LoopSemanticsBuilder>,
    elseBuild: IfBody<LoopSemanticsBuilder>,
    hint?: SemanticBranchHint
  ): void;
}

export type LoopBody = (builder: LoopSemanticsBuilder) => BitValue;

export type InstructionSemantics = (builder: SemanticsBuilder) => void;

export interface SemanticsBuilder extends SemanticOps {
  currentEip(): I32Value;
  nextEip(): I32Value;

  var(seed: I32Value): SemanticVar;
  writeFlag(flag: X86Flag, value: BitValue): void;
  addInstructionCount(amount: I32Value): void;

  if(condition: BitValue, thenBuild: IfBody, hint?: SemanticBranchHint): void;
  ifElse(
    condition: BitValue,
    thenBuild: IfBody,
    elseBuild: IfBody,
    hint?: SemanticBranchHint
  ): void;
  jump(target: I32Value): void;
  loop(body: LoopBody): void;
  hostTrap(vector: Integer<8>): void;
}
