import { assert } from "#common/assert.js";
import { x86Flags, type X86Flag } from "#core/flags/definitions.js";
import { registerAlias } from "#core/registers.js";
import type { SegmentStateField } from "#core/state/fields.js";
import { reg16, reg32, reg8, segmentRegisters, type Reg32, type RegName, type SegmentRegister } from "#core/types.js";
import type { ValueId } from "#compiler/ir/values/types.js";

export type GprChannel = Readonly<{
  kind: "gpr";
  reg: Reg32;
  byteOffsetInReg: 0 | 1;
  byteLength: 1 | 2 | 4;
}>;

export type FlagChannel<TFlag extends X86Flag = X86Flag> = Readonly<{ kind: "flag"; flag: TFlag }>;
export type SegmentChannelField = SegmentStateField;
export type SegmentChannel<
  TSegment extends SegmentRegister = SegmentRegister,
  TField extends SegmentChannelField = SegmentChannelField
> = Readonly<{
  kind: "segment";
  reg: TSegment;
  field: TField;
}>;
export type EipChannel = Readonly<{ kind: "eip" }>;
export type InstructionCountChannel = Readonly<{ kind: "instructionCount" }>;
type LazyFlagsField = "lazyFlagsKind" | "lazyFlagsA" | "lazyFlagsB";
export type LazyFlagsChannel<TField extends LazyFlagsField = LazyFlagsField> = Readonly<{
  kind: "lazyFlags";
  field: TField;
}>;
export type StateChannel =
  | GprChannel
  | FlagChannel
  | SegmentChannel
  | EipChannel
  | InstructionCountChannel
  | LazyFlagsChannel;

// The index is the x86 register number for the access width (modrm encoding).
export type GprDynamicSlot = Readonly<{
  kind: "gprDynamic";
  index: ValueId;
  byteLength: 1 | 2 | 4;
}>;

export type SegmentDynamicSlot = Readonly<{
  kind: "segmentDynamic";
  index: ValueId;
  field: SegmentChannelField;
}>;

export type DynamicStateSlot = GprDynamicSlot | SegmentDynamicSlot;
export type StateSlot = StateChannel | DynamicStateSlot;

export function isDynamicSlot(slot: StateSlot): slot is DynamicStateSlot {
  switch (slot.kind) {
    case "gprDynamic":
    case "segmentDynamic":
      return true;
    case "gpr":
    case "flag":
    case "segment":
    case "eip":
    case "instructionCount":
    case "lazyFlags":
      return false;
  }
}

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

const flagChannels = new Map<X86Flag, FlagChannel>(
  x86Flags.map((flag) => [flag, { kind: "flag", flag }])
);
const segmentSelectorChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "selector">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "selector" }])
);
const segmentBaseChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "base">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "base" }])
);
const segmentLimitChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "limit">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "limit" }])
);
const segmentAccessChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "access">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "access" }])
);

export const eipChannel: EipChannel = { kind: "eip" };
export const instructionCountChannel: InstructionCountChannel = { kind: "instructionCount" };
export const lazyFlagsKindChannel: LazyFlagsChannel<"lazyFlagsKind"> = {
  kind: "lazyFlags",
  field: "lazyFlagsKind"
};
export const lazyFlagsAChannel: LazyFlagsChannel<"lazyFlagsA"> = {
  kind: "lazyFlags",
  field: "lazyFlagsA"
};
export const lazyFlagsBChannel: LazyFlagsChannel<"lazyFlagsB"> = {
  kind: "lazyFlags",
  field: "lazyFlagsB"
};

export function gprChannel(name: RegName): GprChannel {
  const channel = gprChannels.get(name);

  if (channel === undefined) {
    throw new Error(`unknown register channel: ${name}`);
  }

  return channel;
}

export function flagChannel<TFlag extends X86Flag>(flag: TFlag): FlagChannel<TFlag> {
  const channel = flagChannels.get(flag);

  if (channel === undefined) {
    throw new Error(`unknown flag channel: ${flag}`);
  }

  return channel as FlagChannel<TFlag>;
}

export function segmentSelectorChannel<TSegment extends SegmentRegister>(
  reg: TSegment
): SegmentChannel<TSegment, "selector"> {
  const channel = segmentSelectorChannels.get(reg);

  assert(channel !== undefined, `unknown segment selector channel: ${reg}`);

  return channel as SegmentChannel<TSegment, "selector">;
}

export function segmentBaseChannel<TSegment extends SegmentRegister>(reg: TSegment): SegmentChannel<TSegment, "base"> {
  const channel = segmentBaseChannels.get(reg);

  assert(channel !== undefined, `unknown segment base channel: ${reg}`);

  return channel as SegmentChannel<TSegment, "base">;
}

export function segmentLimitChannel<TSegment extends SegmentRegister>(
  reg: TSegment
): SegmentChannel<TSegment, "limit"> {
  const channel = segmentLimitChannels.get(reg);

  assert(channel !== undefined, `unknown segment limit channel: ${reg}`);

  return channel as SegmentChannel<TSegment, "limit">;
}

export function segmentAccessChannel<TSegment extends SegmentRegister>(
  reg: TSegment
): SegmentChannel<TSegment, "access"> {
  const channel = segmentAccessChannels.get(reg);

  assert(channel !== undefined, `unknown segment access channel: ${reg}`);

  return channel as SegmentChannel<TSegment, "access">;
}

export function channelsOverlap(a: StateChannel, b: StateChannel): boolean {
  if (a.kind === "gpr" && b.kind === "gpr") {
    return a.reg === b.reg &&
      a.byteOffsetInReg < b.byteOffsetInReg + b.byteLength &&
      b.byteOffsetInReg < a.byteOffsetInReg + a.byteLength;
  }

  return sameChannel(a, b);
}

// Whether a write to `outer` overwrites every byte of `inner`.
export function channelCovers(outer: StateChannel, inner: StateChannel): boolean {
  if (outer.kind === "gpr" && inner.kind === "gpr") {
    return outer.reg === inner.reg &&
      outer.byteOffsetInReg <= inner.byteOffsetInReg &&
      inner.byteOffsetInReg + inner.byteLength <= outer.byteOffsetInReg + outer.byteLength;
  }

  return sameChannel(outer, inner);
}

export function dedupeDisjointChannels(input: readonly StateChannel[]): readonly StateChannel[] {
  const channels: StateChannel[] = [];

  for (const channel of input) {
    if (channels.some((existing) => channelCovers(existing, channel) && channelCovers(channel, existing))) {
      continue;
    }

    assert(
      channels.every((existing) => !channelsOverlap(existing, channel)),
      "overlapping state channels are unsupported"
    );
    channels.push(channel);
  }

  return channels;
}

function sameChannel(a: StateChannel, b: StateChannel): boolean {
  switch (a.kind) {
    case "gpr":
      return b.kind === "gpr" &&
        a.reg === b.reg &&
        a.byteOffsetInReg === b.byteOffsetInReg &&
        a.byteLength === b.byteLength;
    case "flag":
      return b.kind === "flag" && a.flag === b.flag;
    case "segment":
      return b.kind === "segment" && a.reg === b.reg && a.field === b.field;
    case "eip":
      return b.kind === "eip";
    case "instructionCount":
      return b.kind === "instructionCount";
    case "lazyFlags":
      return b.kind === "lazyFlags" && a.field === b.field;
  }
}
