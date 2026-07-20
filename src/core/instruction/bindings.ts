import type { ValueId } from "#compiler/ir/values/types.js";
import type {
  EffectiveAddress,
  RegName,
  SegmentRegister
} from "#core/types.js";

export type EffectiveAddressTerms = Omit<EffectiveAddress, "segment">;

export type RegOperandBinding = Readonly<{
  kind: "reg";
  reg: RegName;
}>;
export type RegDynamicOperandBinding = Readonly<{
  kind: "regDynamic";
  index: ValueId;
}>;
export type SegmentOperandBinding = Readonly<{
  kind: "segment";
  reg: SegmentRegister;
}>;
export type SegmentDynamicOperandBinding = Readonly<{
  kind: "segmentDynamic";
  index: ValueId;
}>;
export type ImmOperandBinding = Readonly<{
  kind: "imm";
  value: number;
}>;
export type ImmDynamicOperandBinding = Readonly<{
  kind: "immDynamic";
  value: ValueId;
}>;

// Memory bindings keep offset calculation separate from segment selection.
export type StaticMemSegmentBinding = Readonly<{
  kind: "static";
  reg: SegmentRegister;
}>;
export type DynamicMemSegmentBinding = Readonly<{
  kind: "dynamic";
  index: ValueId;
}>;
export type MemSegmentBinding =
  | StaticMemSegmentBinding
  | DynamicMemSegmentBinding;

// All address registers are statically selected and read by the instruction.
export type MemOperandBinding = Readonly<{
  kind: "mem";
  address: EffectiveAddressTerms;
  segment: MemSegmentBinding;
}>;
// Decode already computed the complete offset; no GPR read remains.
export type MemOffsetOperandBinding = Readonly<{
  kind: "memOffset";
  offset: ValueId;
  segment: MemSegmentBinding;
}>;
// The base register is selected dynamically and deliberately read inside the
// instruction; offset contains the already-computed index and displacement.
export type MemDynamicBaseOperandBinding = Readonly<{
  kind: "memDynamicBase";
  baseRegisterIndex: ValueId;
  offset: ValueId;
  segment: MemSegmentBinding;
}>;

export type OperandBinding =
  | RegOperandBinding
  | RegDynamicOperandBinding
  | SegmentOperandBinding
  | SegmentDynamicOperandBinding
  | ImmOperandBinding
  | ImmDynamicOperandBinding
  | MemOperandBinding
  | MemOffsetOperandBinding
  | MemDynamicBaseOperandBinding;

export function regBinding(reg: RegName): RegOperandBinding {
  return { kind: "reg", reg };
}

export function regDynamicBinding(
  index: ValueId
): RegDynamicOperandBinding {
  return { kind: "regDynamic", index };
}

export function segmentBinding(
  reg: SegmentRegister
): SegmentOperandBinding {
  return { kind: "segment", reg };
}

export function segmentDynamicBinding(
  index: ValueId
): SegmentDynamicOperandBinding {
  return { kind: "segmentDynamic", index };
}

export function immBinding(value: number): ImmOperandBinding {
  return { kind: "imm", value };
}

export function immDynamicBinding(
  value: ValueId
): ImmDynamicOperandBinding {
  return { kind: "immDynamic", value };
}

export function memBinding(
  address: EffectiveAddressTerms,
  segment: MemSegmentBinding
): MemOperandBinding {
  return { kind: "mem", address, segment };
}

export function memOffsetBinding(
  offset: ValueId,
  segment: MemSegmentBinding
): MemOffsetOperandBinding {
  return { kind: "memOffset", offset, segment };
}

export function memDynamicBaseBinding(
  baseRegisterIndex: ValueId,
  offset: ValueId,
  segment: MemSegmentBinding
): MemDynamicBaseOperandBinding {
  return {
    kind: "memDynamicBase",
    baseRegisterIndex,
    offset,
    segment
  };
}

export function staticMemSegment(
  reg: SegmentRegister
): StaticMemSegmentBinding {
  return { kind: "static", reg };
}

export function dynamicMemSegment(
  index: ValueId
): DynamicMemSegmentBinding {
  return { kind: "dynamic", index };
}
