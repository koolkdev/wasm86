import type { FlagName } from "#ir/model/flags.js";
import { registerAlias } from "#x86/registers.js";
import { x86ArithmeticFlags } from "#x86/flags.js";
import { reg16, reg32, reg8, type Reg32, type RegName } from "#x86/types.js";

export type GprChannel = Readonly<{
  kind: "gpr";
  reg: Reg32;
  byteOffsetInReg: 0 | 1;
  byteLength: 1 | 2 | 4;
}>;

export type FlagChannel = Readonly<{ kind: "flag"; flag: FlagName }>;
export type EipChannel = Readonly<{ kind: "eip" }>;
export type StateChannel = GprChannel | FlagChannel | EipChannel;

const byteOffsetFromBitOffset = { 0: 0, 8: 1 } as const;
const byteLengthFromWidth = { 8: 1, 16: 2, 32: 4 } as const;

const gprChannels = new Map<RegName, GprChannel>(
  [...reg32, ...reg16, ...reg8].map((name) => {
    const alias = registerAlias(name);

    return [name, {
      kind: "gpr",
      reg: alias.base,
      byteOffsetInReg: byteOffsetFromBitOffset[alias.bitOffset],
      byteLength: byteLengthFromWidth[alias.width]
    }];
  })
);

const flagChannels = new Map<FlagName, FlagChannel>(
  x86ArithmeticFlags.map((flag) => [flag, { kind: "flag", flag }])
);

export const eipChannel: EipChannel = { kind: "eip" };

export function gprChannel(name: RegName): GprChannel {
  const channel = gprChannels.get(name);

  if (channel === undefined) {
    throw new Error(`unknown register channel: ${name}`);
  }

  return channel;
}

export function flagChannel(flag: FlagName): FlagChannel {
  const channel = flagChannels.get(flag);

  if (channel === undefined) {
    throw new Error(`unknown flag channel: ${flag}`);
  }

  return channel;
}

export function channelsOverlap(a: StateChannel, b: StateChannel): boolean {
  if (a.kind === "gpr" && b.kind === "gpr") {
    return a.reg === b.reg &&
      a.byteOffsetInReg < b.byteOffsetInReg + b.byteLength &&
      b.byteOffsetInReg < a.byteOffsetInReg + a.byteLength;
  }

  if (a.kind === "flag" && b.kind === "flag") {
    return a.flag === b.flag;
  }

  return a.kind === "eip" && b.kind === "eip";
}
