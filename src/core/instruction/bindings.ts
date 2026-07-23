import type { ValueId } from "#compiler/ir/values/types.js";
import type {
  EffectiveAddress,
  RegName,
  SegmentRegister
} from "#core/types.js";

export type EffectiveAddressComponents = Omit<EffectiveAddress, "segment">;

export type RegBindingSelection =
  | Readonly<{
      kind: "static";
      reg: RegName;
    }>
  | Readonly<{
      kind: "dynamic";
      index: ValueId;
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
      index: ValueId;
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
      value: ValueId;
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
      baseRegisterIndex: ValueId | undefined;
      // Without a base this is the complete offset; otherwise it is index + disp.
      addend: ValueId;
    }>;

export type MemOperandBinding = Readonly<{
  kind: "mem";
  address: MemAddressSource;
  segment: SegmentBindingSelection;
}>;

export type OperandBinding =
  | RegOperandBinding
  | SegmentOperandBinding
  | ImmOperandBinding
  | MemOperandBinding;

export function regBinding(reg: RegName): RegOperandBinding {
  return {
    kind: "reg",
    selection: { kind: "static", reg }
  };
}

export function regDynamicBinding(
  index: ValueId
): RegOperandBinding {
  return {
    kind: "reg",
    selection: { kind: "dynamic", index }
  };
}

export function segmentBinding(
  reg: SegmentRegister
): SegmentOperandBinding {
  return {
    kind: "segment",
    selection: { kind: "static", reg }
  };
}

export function segmentDynamicBinding(
  index: ValueId
): SegmentOperandBinding {
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

export function immDynamicBinding(
  value: ValueId
): ImmOperandBinding {
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
  offset: ValueId,
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
  baseRegisterIndex: ValueId,
  addend: ValueId,
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

export function staticMemSegment(
  reg: SegmentRegister
): SegmentBindingSelection {
  return { kind: "static", reg };
}

export function dynamicMemSegment(
  index: ValueId
): SegmentBindingSelection {
  return { kind: "dynamic", index };
}
