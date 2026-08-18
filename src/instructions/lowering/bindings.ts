import type { Integer, I32Value } from "#compiler/function/values.js";
import type { EffectiveAddress, RegName, SegmentRegister } from "#core/types.js";

export type EffectiveAddressComponents = Omit<EffectiveAddress, "segment">;

export type RegBindingSelection =
  | Readonly<{
      kind: "static";
      reg: RegName;
    }>
  | Readonly<{
      kind: "dynamic";
      index: Integer<8>;
    }>;

export type RegOperandBinding = Readonly<{
  kind: "reg";
  selection: RegBindingSelection;
}>;

export type SegmentBindingSelection =
  | Readonly<{
      kind: "static";
      reg: SegmentRegister;
    }>
  | Readonly<{
      kind: "dynamic";
      index: Integer<8>;
    }>;

export type SegmentOperandBinding = Readonly<{
  kind: "segment";
  selection: SegmentBindingSelection;
}>;

export type ImmBindingSource =
  | Readonly<{
      kind: "static";
      value: number;
    }>
  | Readonly<{
      kind: "dynamic";
      value: I32Value;
    }>;

export type ImmOperandBinding = Readonly<{
  kind: "imm";
  source: ImmBindingSource;
}>;

export type MemAddressSource =
  | Readonly<{
      // Register selections are static; their contents are read by the
      // instruction.
      kind: "static";
      components: EffectiveAddressComponents;
    }>
  | Readonly<{
      kind: "dynamic";
      // When present, the selected base is deliberately read by the
      // instruction.
      baseRegisterIndex: Integer<8> | undefined;
      // Without a base this is the complete offset; otherwise it is index + disp.
      addend: I32Value;
    }>;

export type MemOperandBinding = Readonly<{
  kind: "mem";
  address: MemAddressSource;
  segment: SegmentBindingSelection;
}>;

export type OperandBinding =
  RegOperandBinding | SegmentOperandBinding | ImmOperandBinding | MemOperandBinding;

export function regBinding(reg: RegName): RegOperandBinding {
  return {
    kind: "reg",
    selection: { kind: "static", reg }
  };
}

export function regDynamicBinding(index: Integer<8>): RegOperandBinding {
  return {
    kind: "reg",
    selection: { kind: "dynamic", index }
  };
}

export function segmentBinding(reg: SegmentRegister): SegmentOperandBinding {
  return {
    kind: "segment",
    selection: { kind: "static", reg }
  };
}

export function segmentDynamicBinding(index: Integer<8>): SegmentOperandBinding {
  return {
    kind: "segment",
    selection: { kind: "dynamic", index }
  };
}

export function immBinding(value: number): ImmOperandBinding {
  return {
    kind: "imm",
    source: { kind: "static", value }
  };
}

export function immDynamicBinding(value: I32Value): ImmOperandBinding {
  return {
    kind: "imm",
    source: { kind: "dynamic", value }
  };
}

export function memBinding(
  components: EffectiveAddressComponents,
  segment: SegmentBindingSelection
): MemOperandBinding {
  return {
    kind: "mem",
    address: { kind: "static", components },
    segment
  };
}

export function memOffsetBinding(
  offset: I32Value,
  segment: SegmentBindingSelection
): MemOperandBinding {
  return {
    kind: "mem",
    address: {
      kind: "dynamic",
      baseRegisterIndex: undefined,
      addend: offset
    },
    segment
  };
}

export function memDynamicBaseBinding(
  baseRegisterIndex: Integer<8>,
  addend: I32Value,
  segment: SegmentBindingSelection
): MemOperandBinding {
  return {
    kind: "mem",
    address: {
      kind: "dynamic",
      baseRegisterIndex,
      addend
    },
    segment
  };
}

export function staticMemSegment(reg: SegmentRegister): SegmentBindingSelection {
  return { kind: "static", reg };
}

export function dynamicMemSegment(index: Integer<8>): SegmentBindingSelection {
  return { kind: "dynamic", index };
}
