import type { EffectiveAddress, RegName, SegmentRegister } from "#core/types.js";
import type { ExternalValueId } from "#compiler/ir/values/types.js";
import { gprChannel, segmentSelectorChannel, type GprChannel, type SegmentChannel } from "./slots.js";

export type EffectiveAddressTerms = Omit<EffectiveAddress, "segment">;

// Each storage family has a static form and a runtime-bound form whose
// payload arrives as an external value: a register index, an operand value
// (decoded immediate or resolved branch target), or a computed address.
export type RegOperandBinding = Readonly<{ kind: "reg"; channel: GprChannel }>;
export type RegDynamicOperandBinding = Readonly<{ kind: "regDynamic"; index: ExternalValueId }>;
export type SegmentOperandBinding = Readonly<{ kind: "segment"; channel: SegmentChannel<SegmentRegister, "selector"> }>;
export type SegmentDynamicOperandBinding = Readonly<{ kind: "segmentDynamic"; index: ExternalValueId }>;
export type ImmOperandBinding = Readonly<{ kind: "imm"; value: number }>;
export type ImmExternalOperandBinding = Readonly<{ kind: "immExternal"; value: ExternalValueId }>;
// Memory bindings keep offset calculation separate from segment selection.
export type MemSegmentBinding =
  | Readonly<{ kind: "static"; reg: SegmentRegister }>
  | Readonly<{ kind: "dynamic"; value: ExternalValueId }>;
export type MemOperandBinding = Readonly<{
  kind: "mem";
  address: EffectiveAddressTerms;
  segment: MemSegmentBinding;
}>;
// An address with no state-dependent term, resolved at decode.
export type MemStaticOperandBinding = Readonly<{
  kind: "memStatic";
  address: ExternalValueId;
  segment: MemSegmentBinding;
}>;
// base holds a GPR word index 0..7, read inside the instruction so pop's
// esp-based EA sees the incremented esp; offset pre-sums the other terms.
// Dynamic segment values use the segmentRegisters index order.
export type MemDynamicOperandBinding = Readonly<{
  kind: "memDynamic";
  base: ExternalValueId;
  offset: ExternalValueId;
  segment: MemSegmentBinding;
}>;

export type OperandBinding =
  | RegOperandBinding
  | RegDynamicOperandBinding
  | SegmentOperandBinding
  | SegmentDynamicOperandBinding
  | ImmOperandBinding
  | ImmExternalOperandBinding
  | MemOperandBinding
  | MemStaticOperandBinding
  | MemDynamicOperandBinding;

export function regBinding(name: RegName): RegOperandBinding {
  return { kind: "reg", channel: gprChannel(name) };
}

export function regDynamicBinding(index: ExternalValueId): RegDynamicOperandBinding {
  return { kind: "regDynamic", index };
}

export function segmentBinding(reg: SegmentRegister): SegmentOperandBinding {
  return { kind: "segment", channel: segmentSelectorChannel(reg) };
}

export function segmentDynamicBinding(index: ExternalValueId): SegmentDynamicOperandBinding {
  return { kind: "segmentDynamic", index };
}

export function immBinding(value: number): ImmOperandBinding {
  return { kind: "imm", value };
}

export function immExternalBinding(value: ExternalValueId): ImmExternalOperandBinding {
  return { kind: "immExternal", value };
}

export function memBinding(
  address: EffectiveAddressTerms,
  segment: MemSegmentBinding
): MemOperandBinding {
  return { kind: "mem", address, segment };
}

export function memStaticBinding(
  address: ExternalValueId,
  segment: MemSegmentBinding
): MemStaticOperandBinding {
  return { kind: "memStatic", address, segment };
}

export function staticMemSegment(reg: SegmentRegister): MemSegmentBinding {
  return { kind: "static", reg };
}

export function dynamicMemSegment(value: ExternalValueId): MemSegmentBinding {
  return { kind: "dynamic", value };
}

export function memDynamicBinding(
  base: ExternalValueId,
  offset: ExternalValueId,
  segment: MemSegmentBinding
): MemDynamicOperandBinding {
  return { kind: "memDynamic", base, offset, segment };
}
