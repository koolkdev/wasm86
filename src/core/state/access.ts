import { assert } from "#common/assert.js";
import {
  resourceRead,
  resourceWrite
} from "#compiler/ir/operations/resource.js";
import type {
  ResourceByteOperand,
  ResourceEffect,
  ResourceReadMode,
  ResourceRef
} from "#compiler/ir/resource.js";
import type {
  IntegerWidth,
  ValueId
} from "#compiler/ir/values/types.js";
import {
  widthByteLength,
  type FieldRef,
  type LayoutByteLength,
  type LayoutWidth,
  type NamedArrayRef
} from "#compiler/layout/handles.js";
import type { Layout, LayoutNamedArray } from "#compiler/layout/layout.js";
import { registerAlias } from "#core/registers.js";
import { coreStateFields } from "#core/state/layout.js";
import type { GprChannel, SegmentStateField } from "#core/state/channels.js";
import type {
  OperandWidth,
  RegName,
  SegmentRegister
} from "#core/types.js";
import type { RegionBuilder } from "#compiler/ir/builder/region.js";
import type { ValueBuilder } from "#compiler/ir/values/builder.js";

export type StateResource = Readonly<{
  resource: ResourceRef;
  layout: Layout;
}>;

export class StateAccess {
  readonly #state: StateResource;

  constructor(state: StateResource) {
    this.#state = state;
  }

  bind(region: RegionBuilder): BoundStateAccess {
    return new BoundStateAccess(this.#state, region);
  }

  fieldEffect(field: FieldRef): ResourceEffect {
    const placed = this.#state.layout.field(field);

    return resourceEffect(this.#state, placed.offset, placed.byteLength);
  }

  gprEffect(reg: RegName | GprChannel): ResourceEffect {
    const alias = registerAlias(typeof reg === "string" ? reg : reg.reg);
    const slice = namedArrayElementSlice(
      this.#state,
      coreStateFields.gprs,
      coreStateFields.gprs.elementIndex(alias.base),
      alias.bitOffset / 8,
      widthByteLength(layoutWidth(alias.width))
    );

    return resourceEffect(
      this.#state,
      slice.byteOffset,
      slice.byteLength
    );
  }

  segmentEffect(
    reg: SegmentRegister,
    field: SegmentStateField
  ): ResourceEffect {
    const arrayRef = segmentNamedArray(field);
    const slice = namedArrayElementSlice(
      this.#state,
      arrayRef,
      arrayRef.elementIndex(reg),
      0,
      widthByteLength(arrayRef.elementWidth)
    );

    return resourceEffect(
      this.#state,
      slice.byteOffset,
      slice.byteLength
    );
  }

  owns(effect: ResourceEffect): boolean {
    return effect.resource === this.#state.resource;
  }
}

export class BoundStateAccess {
  readonly #state: StateResource;
  readonly #region: RegionBuilder;

  constructor(state: StateResource, region: RegionBuilder) {
    this.#state = state;
    this.#region = region;
  }

  // Derives the same state owner for an explicitly supplied structured child;
  // the binding never follows mutable builder state.
  forRegion(region: RegionBuilder): BoundStateAccess {
    return new BoundStateAccess(this.#state, region);
  }

  get values(): ValueBuilder {
    return this.#region.values;
  }

  gpr(reg: RegName): ResourceByteOperand {
    const alias = registerAlias(reg);

    return this.#namedArrayElement(
      coreStateFields.gprs,
      coreStateFields.gprs.elementIndex(alias.base),
      alias.bitOffset / 8,
      widthByteLength(layoutWidth(alias.width))
    );
  }

  gprChannel(channel: GprChannel): ResourceByteOperand {
    return this.gpr(channel.reg);
  }

  owns(effect: ResourceEffect): boolean {
    return effect.resource === this.#state.resource;
  }

  dynamicGpr(index: ValueId, width: OperandWidth): ResourceByteOperand {
    const values = this.#region.values;
    const byteLength = widthByteLength(layoutWidth(width));
    const array = this.#state.layout.namedArray(coreStateFields.gprs);
    const strideShift = powerOfTwoShift(array.stride);
    const relativeOffset = width === 8
      ? values.binary(
          "add",
          values.binary(
            "shl",
            values.binary("and", index, values.const(3)),
            values.const(strideShift)
          ),
          values.binary(
            "and",
            values.binary("shr_u", index, values.const(2)),
            values.const(1)
          )
        )
      : values.binary(
          "shl",
          values.binary("and", index, values.const(7)),
          values.const(strideShift)
        );

    return this.#dynamicNamedArray(
      coreStateFields.gprs,
      array,
      relativeOffset,
      byteLength
    );
  }

  segment(reg: SegmentRegister, field: SegmentStateField): ResourceByteOperand {
    const array = segmentNamedArray(field);

    return this.#namedArrayElement(
      array,
      array.elementIndex(reg),
      0,
      widthByteLength(array.elementWidth)
    );
  }

  dynamicSegment(index: ValueId, field: SegmentStateField): ResourceByteOperand {
    const values = this.#region.values;
    const arrayRef = segmentNamedArray(field);
    const array = this.#state.layout.namedArray(arrayRef);
    const relativeOffset = values.binary(
      "shl",
      index,
      values.const(powerOfTwoShift(array.stride))
    );

    return this.#dynamicNamedArray(
      arrayRef,
      array,
      relativeOffset,
      array.elementByteLength
    );
  }

  field<TWidth extends LayoutWidth>(field: FieldRef<TWidth>): ResourceByteOperand {
    const placed = this.#state.layout.field(field);

    return this.#staticOperand(
      placed.offset,
      placed.byteLength,
      integerWidth(field.width)
    );
  }

  read(operand: ResourceByteOperand, mode?: ResourceReadMode): ValueId {
    assert(this.owns(operand.effect), "operand belongs to another resource");
    assert(
      mode?.kind !== "signed" || operand.width !== 32,
      "a 32-bit state read has no signed extension"
    );

    return this.#region.operation(
      resourceRead,
      mode === undefined ? { source: operand } : { source: operand, mode }
    );
  }

  readField<TWidth extends LayoutWidth>(
    field: FieldRef<TWidth>,
    mode?: ResourceReadMode
  ): ValueId {
    return this.read(this.field(field), mode);
  }

  write(operand: ResourceByteOperand, value: ValueId): void {
    assert(this.owns(operand.effect), "operand belongs to another resource");
    this.#region.operation(resourceWrite, { destination: operand, value });
  }

  #namedArrayElement<TWidth extends LayoutWidth>(
    arrayRef: NamedArrayRef<TWidth>,
    index: number,
    byteOffset: number,
    byteLength: LayoutByteLength
  ): ResourceByteOperand {
    const slice = namedArrayElementSlice(
      this.#state,
      arrayRef,
      index,
      byteOffset,
      byteLength
    );

    return this.#staticOperand(
      slice.byteOffset,
      slice.byteLength,
      byteLengthWidth(slice.byteLength)
    );
  }

  #dynamicNamedArray<TWidth extends LayoutWidth>(
    arrayRef: NamedArrayRef<TWidth>,
    array: LayoutNamedArray<TWidth>,
    relativeOffset: ValueId,
    byteLength: LayoutByteLength
  ): ResourceByteOperand {
    const staticRelativeOffset = this.#region.values.constValue(relativeOffset);

    if (staticRelativeOffset !== undefined) {
      assert(
        Number.isInteger(staticRelativeOffset) && staticRelativeOffset >= 0 &&
          staticRelativeOffset + byteLength <= array.stride * array.count,
        `access exceeds named layout array ${arrayRef.id}`
      );

      return this.#staticOperand(
        array.offset + staticRelativeOffset,
        byteLength,
        byteLengthWidth(byteLength)
      );
    }

    return {
      effect: this.#effect(array.offset, array.stride * array.count),
      address: {
        base: relativeOffset,
        displacement: array.offset
      },
      width: byteLengthWidth(byteLength)
    };
  }

  #staticOperand(
    byteOffset: number,
    byteLength: LayoutByteLength,
    width: IntegerWidth
  ): ResourceByteOperand {
    const values = this.#region.values;

    return {
      effect: this.#effect(byteOffset, byteLength),
      address: {
        base: values.const(0),
        displacement: byteOffset
      },
      width
    };
  }

  #effect(byteOffset: number, byteLength: number): ResourceEffect {
    return resourceEffect(this.#state, byteOffset, byteLength);
  }
}

function namedArrayElementSlice<TWidth extends LayoutWidth>(
  state: StateResource,
  arrayRef: NamedArrayRef<TWidth>,
  index: number,
  byteOffset: number,
  byteLength: LayoutByteLength
): Readonly<{ byteOffset: number; byteLength: LayoutByteLength }> {
  const array = state.layout.namedArray(arrayRef);

  assert(
    Number.isInteger(index) && index >= 0 && index < array.count,
    `invalid element index ${index} for named layout array ${arrayRef.id}`
  );
  assert(
    Number.isInteger(byteOffset) && byteOffset >= 0 &&
      byteOffset + byteLength <= array.elementByteLength,
    `access exceeds named layout array element ${arrayRef.id}`
  );

  return {
    byteOffset: array.offset + index * array.stride + byteOffset,
    byteLength
  };
}

function resourceEffect(
  state: StateResource,
  byteOffset: number,
  byteLength: number
): ResourceEffect {
  return {
    space: "resource",
    resource: state.resource,
    range: {
      basis: { kind: "resource" },
      slice: { byteOffset, byteLength }
    }
  };
}

function segmentNamedArray(
  field: SegmentStateField
): NamedArrayRef<"u16" | "u32", SegmentRegister> {
  switch (field) {
    case "selector":
      return coreStateFields.segmentSelectors;
    case "base":
      return coreStateFields.segmentBases;
    case "limit":
      return coreStateFields.segmentLimits;
    case "access":
      return coreStateFields.segmentAccess;
  }
}

function layoutWidth(width: OperandWidth): LayoutWidth {
  switch (width) {
    case 8:
      return "u8";
    case 16:
      return "u16";
    case 32:
      return "u32";
  }
}

function integerWidth(width: LayoutWidth): IntegerWidth {
  switch (width) {
    case "u8":
      return 8;
    case "u16":
      return 16;
    case "u32":
      return 32;
  }
}

function byteLengthWidth(byteLength: LayoutByteLength): IntegerWidth {
  switch (byteLength) {
    case 1:
      return 8;
    case 2:
      return 16;
    case 4:
      return 32;
  }
}

function powerOfTwoShift(value: number): number {
  assert(
    Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0,
    `execution-state array stride must be a positive power of two, got ${value}`
  );
  return Math.log2(value);
}
