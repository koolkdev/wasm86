import type { EffectiveAddress, RegName } from "#x86/types.js";
import { gprChannel, type GprChannel } from "./slots.js";

export type ExternalValueId = number;

// Each storage family has a static form and a runtime-bound form whose
// payload arrives as an external value: a register index, an operand value
// (decoded immediate or resolved branch target), or a computed address.
export type RegOperandBinding = Readonly<{ kind: "reg"; channel: GprChannel }>;
export type RegDynamicOperandBinding = Readonly<{ kind: "regDynamic"; index: ExternalValueId }>;
export type ImmOperandBinding = Readonly<{ kind: "imm"; value: number }>;
export type ImmExternalOperandBinding = Readonly<{ kind: "immExternal"; value: ExternalValueId }>;
export type MemOperandBinding = Readonly<{ kind: "mem"; address: EffectiveAddress }>;
// An address with no state-dependent term, resolved at decode.
export type MemStaticOperandBinding = Readonly<{ kind: "memStatic"; address: ExternalValueId }>;
// base holds a GPR word index 0..7, read inside the instruction so pop's
// esp-based EA sees the incremented esp; offset pre-sums the other terms.
export type MemDynamicOperandBinding = Readonly<{
  kind: "memDynamic";
  base: ExternalValueId;
  offset: ExternalValueId;
}>;

export type OperandBinding =
  | RegOperandBinding
  | RegDynamicOperandBinding
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

export function immBinding(value: number): ImmOperandBinding {
  return { kind: "imm", value };
}

export function immExternalBinding(value: ExternalValueId): ImmExternalOperandBinding {
  return { kind: "immExternal", value };
}

export function memBinding(address: EffectiveAddress): MemOperandBinding {
  return { kind: "mem", address };
}

export function memStaticBinding(address: ExternalValueId): MemStaticOperandBinding {
  return { kind: "memStatic", address };
}

export function memDynamicBinding(base: ExternalValueId, offset: ExternalValueId): MemDynamicOperandBinding {
  return { kind: "memDynamic", base, offset };
}
