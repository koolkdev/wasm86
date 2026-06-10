import type { EffectiveAddress, RegName } from "#x86/types.js";
import { gprChannel, type GprChannel } from "./slots.js";

export type ExternalValueId = number;

export type RegOperandBinding = Readonly<{ kind: "reg"; channel: GprChannel }>;
export type ImmOperandBinding = Readonly<{ kind: "imm"; value: number }>;
export type MemOperandBinding = Readonly<{ kind: "mem"; address: EffectiveAddress }>;
// A runtime value supplied by the host function, e.g. an interpreter local.
export type ExternalOperandBinding = Readonly<{ kind: "external"; id: ExternalValueId }>;

export type OperandBinding =
  | RegOperandBinding
  | ImmOperandBinding
  | MemOperandBinding
  | ExternalOperandBinding;

export function regBinding(name: RegName): RegOperandBinding {
  return { kind: "reg", channel: gprChannel(name) };
}

export function immBinding(value: number): ImmOperandBinding {
  return { kind: "imm", value };
}

export function memBinding(address: EffectiveAddress): MemOperandBinding {
  return { kind: "mem", address };
}
