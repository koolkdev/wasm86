import { assert } from "#common/assert.js";
import {
  reg16,
  reg32,
  reg8,
  segmentRegisters,
  type RegName,
  type SegmentRegister
} from "#core/types.js";

export type SegmentStateField = "selector" | "base" | "limit" | "access";

export type GprChannel<TReg extends RegName = RegName> = Readonly<{
  kind: "gpr";
  reg: TReg;
}>;

export type SegmentChannel<
  TSegment extends SegmentRegister = SegmentRegister,
  TField extends SegmentStateField = SegmentStateField
> = Readonly<{
  kind: "segment";
  reg: TSegment;
  field: TField;
}>;

const gprChannels = new Map<RegName, GprChannel>(
  [...reg32, ...reg16, ...reg8].map((reg) => [reg, { kind: "gpr", reg }])
);
const segmentSelectorChannels = new Map<
  SegmentRegister,
  SegmentChannel<SegmentRegister, "selector">
>(segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "selector" }]));
const segmentBaseChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "base">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "base" }])
);
const segmentLimitChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "limit">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "limit" }])
);
const segmentAccessChannels = new Map<SegmentRegister, SegmentChannel<SegmentRegister, "access">>(
  segmentRegisters.map((reg) => [reg, { kind: "segment", reg, field: "access" }])
);

export function gprChannel<TReg extends RegName>(name: TReg): GprChannel<TReg> {
  const channel = gprChannels.get(name);

  assert(channel !== undefined, `unknown register channel: ${name}`);
  return channel as GprChannel<TReg>;
}

export function segmentSelectorChannel<TSegment extends SegmentRegister>(
  reg: TSegment
): SegmentChannel<TSegment, "selector"> {
  const channel = segmentSelectorChannels.get(reg);

  assert(channel !== undefined, `unknown segment selector channel: ${reg}`);
  return channel as SegmentChannel<TSegment, "selector">;
}

export function segmentBaseChannel<TSegment extends SegmentRegister>(
  reg: TSegment
): SegmentChannel<TSegment, "base"> {
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
