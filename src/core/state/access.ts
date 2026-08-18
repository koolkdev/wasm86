import { assert } from "#common/assert.js";
import type { RegionBuilder } from "#compiler/function/builder/region.js";
import type {
  ResourceAccess,
  ResourceEffect,
  StorageWidth,
  ValueWidthForStorage
} from "#compiler/function/resource.js";
import {
  i32,
  type AnyNarrowInteger,
  type I32Value,
  type Integer
} from "#compiler/function/values.js";
import {
  layoutBitWidth,
  widthByteLength,
  type AnyFieldRef,
  type FieldRef,
  type LayoutBitWidth,
  type LayoutByteLength,
  type LayoutWidth,
  type NamedArrayRef
} from "#compiler/layout/handles.js";
import type { Layout, LayoutNamedArray } from "#compiler/layout/layout.js";
import type { ResourceRef } from "#compiler/reference.js";
import { registerAlias } from "#core/registers.js";
import type { GprChannel, SegmentStateField } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import type { OperandWidth, RegisterWidth, RegName, SegmentRegister } from "#core/types.js";

const segmentArrayByField = {
  selector: coreStateFields.segmentSelectors,
  base: coreStateFields.segmentBases,
  limit: coreStateFields.segmentLimits,
  access: coreStateFields.segmentAccess
} as const;

const segmentBitWidthByField = {
  selector: 16,
  base: 32,
  limit: 32,
  access: 32
} as const;

type SegmentBitWidth<Field extends SegmentStateField> = (typeof segmentBitWidthByField)[Field];
type StateStorageWidth = LayoutBitWidth<LayoutWidth>;

export type StateResource = Readonly<{
  resource: ResourceRef;
  layout: Layout;
}>;

export class StateAccess {
  readonly #state: StateResource;

  constructor(state: StateResource) {
    this.#state = state;
  }

  forRegion(region: RegionBuilder): BoundStateAccess {
    return new BoundStateAccess(this.#state, region);
  }

  fieldEffect(field: AnyFieldRef): ResourceEffect {
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
      bitWidthByteLength(alias.width)
    );

    return resourceEffect(this.#state, slice.byteOffset, slice.byteLength);
  }

  segmentEffect(reg: SegmentRegister, field: SegmentStateField): ResourceEffect {
    const arrayRef = segmentNamedArray(field);
    const slice = namedArrayElementSlice(
      this.#state,
      arrayRef,
      arrayRef.elementIndex(reg),
      0,
      widthByteLength(arrayRef.elementWidth)
    );

    return resourceEffect(this.#state, slice.byteOffset, slice.byteLength);
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

  forRegion(region: RegionBuilder): BoundStateAccess {
    return new BoundStateAccess(this.#state, region);
  }

  sameValue(a: AnyNarrowInteger, b: AnyNarrowInteger): boolean {
    return this.#region.sameValue(a, b);
  }

  gpr<Name extends RegName>(reg: Name): ResourceAccess<RegisterWidth<Name>> {
    const alias = registerAlias(reg);

    return this.#namedArrayElement(
      coreStateFields.gprs,
      coreStateFields.gprs.elementIndex(alias.base),
      alias.bitOffset / 8,
      alias.width
    );
  }

  gprChannel<Name extends RegName>(channel: GprChannel<Name>): ResourceAccess<RegisterWidth<Name>>;
  gprChannel<Width extends OperandWidth>(channel: GprChannel, width: Width): ResourceAccess<Width>;
  gprChannel(channel: GprChannel, width?: OperandWidth): ResourceAccess<OperandWidth> {
    const operand = this.gpr(channel.reg);

    if (width !== undefined) {
      assert(operand.storageWidth === width, `${channel.reg} is not a ${width}-bit GPR channel`);
    }

    return operand;
  }

  owns(effect: ResourceEffect): boolean {
    return effect.resource === this.#state.resource;
  }

  dynamicGpr<Width extends OperandWidth>(index: Integer<8>, width: Width): ResourceAccess<Width> {
    const array = this.#state.layout.namedArray(coreStateFields.gprs);
    const strideShift = powerOfTwoShift(array.stride);
    const relativeOffset =
      width === 8
        ? index.and(3).shl(strideShift).add(index.unsigned.shr(2).and(1)).unsigned.extend(32)
        : index.and(7).shl(strideShift).unsigned.extend(32);

    return this.#dynamicNamedArray(coreStateFields.gprs, array, relativeOffset, width);
  }

  segment<Field extends SegmentStateField>(
    reg: SegmentRegister,
    field: Field
  ): ResourceAccess<SegmentBitWidth<Field>> {
    const array = segmentNamedArray(field);

    return this.#namedArrayElement(
      array,
      array.elementIndex(reg),
      0,
      segmentBitWidthByField[field]
    );
  }

  dynamicSegment<Field extends SegmentStateField>(
    index: Integer<8>,
    field: Field
  ): ResourceAccess<SegmentBitWidth<Field>> {
    const arrayRef = segmentNamedArray(field);
    const array = this.#state.layout.namedArray(arrayRef);
    const relativeOffset = index.shl(powerOfTwoShift(array.stride)).unsigned.extend(32);

    return this.#dynamicNamedArray(arrayRef, array, relativeOffset, segmentBitWidthByField[field]);
  }

  field<
    TWidth extends LayoutWidth,
    TValueWidth extends ValueWidthForStorage<LayoutBitWidth<TWidth>>
  >(field: FieldRef<TWidth, TValueWidth>): ResourceAccess<LayoutBitWidth<TWidth>, TValueWidth> {
    const placed = this.#state.layout.field(field);

    return this.#staticOperand(placed.offset, layoutBitWidth(field.width), field.valueWidth);
  }

  read<StoredWidth extends StorageWidth, ValueWidth extends ValueWidthForStorage<StoredWidth>>(
    operand: ResourceAccess<StoredWidth, ValueWidth>
  ): Integer<ValueWidth> {
    assert(this.owns(operand.effect), "operand belongs to another resource");

    return this.#region.readResource(operand);
  }

  readField<
    TWidth extends LayoutWidth,
    TValueWidth extends ValueWidthForStorage<LayoutBitWidth<TWidth>>
  >(field: FieldRef<TWidth, TValueWidth>): Integer<TValueWidth> {
    return this.read(this.field(field));
  }

  write<StoredWidth extends StorageWidth, ValueWidth extends ValueWidthForStorage<StoredWidth>>(
    operand: ResourceAccess<StoredWidth, ValueWidth>,
    value: Integer<NoInfer<ValueWidth>>
  ): void {
    assert(this.owns(operand.effect), "operand belongs to another resource");
    this.#region.writeResource(operand, value);
  }

  #namedArrayElement<TWidth extends LayoutWidth, Width extends StateStorageWidth>(
    arrayRef: NamedArrayRef<TWidth>,
    index: number,
    byteOffset: number,
    width: Width
  ): ResourceAccess<Width> {
    const byteLength = bitWidthByteLength(width);
    const slice = namedArrayElementSlice(this.#state, arrayRef, index, byteOffset, byteLength);

    return this.#staticOperand(slice.byteOffset, width);
  }

  #dynamicNamedArray<TWidth extends LayoutWidth, Width extends StateStorageWidth>(
    arrayRef: NamedArrayRef<TWidth>,
    array: LayoutNamedArray<TWidth>,
    relativeOffset: I32Value,
    width: Width
  ): ResourceAccess<Width> {
    const byteLength = bitWidthByteLength(width);
    const staticRelativeOffset = this.#region.constValue(relativeOffset);

    if (staticRelativeOffset !== undefined) {
      assert(
        Number.isInteger(staticRelativeOffset) &&
          staticRelativeOffset >= 0 &&
          staticRelativeOffset + byteLength <= array.stride * array.count,
        `access exceeds named layout array ${arrayRef.id}`
      );

      return this.#staticOperand(array.offset + staticRelativeOffset, width);
    }

    return {
      effect: this.#effect(array.offset, array.stride * array.count),
      address: {
        base: relativeOffset,
        displacement: array.offset
      },
      storageWidth: width,
      valueWidth: width
    };
  }

  #staticOperand<Width extends StateStorageWidth>(
    byteOffset: number,
    width: Width
  ): ResourceAccess<Width>;
  #staticOperand<Width extends StateStorageWidth, ValueWidth extends ValueWidthForStorage<Width>>(
    byteOffset: number,
    width: Width,
    valueWidth: ValueWidth
  ): ResourceAccess<Width, ValueWidth>;
  #staticOperand(
    byteOffset: number,
    storageWidth: StateStorageWidth,
    valueWidth: ValueWidthForStorage<StateStorageWidth> = storageWidth
  ): ResourceAccess<StateStorageWidth, ValueWidthForStorage<StateStorageWidth>> {
    return {
      effect: this.#effect(byteOffset, bitWidthByteLength(storageWidth)),
      address: {
        base: i32(0),
        displacement: byteOffset
      },
      storageWidth,
      valueWidth
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
    Number.isInteger(byteOffset) &&
      byteOffset >= 0 &&
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
    kind: "resource",
    resource: state.resource,
    range: {
      kind: "slice",
      origin: "resource",
      byteOffset,
      byteLength
    }
  };
}

function segmentNamedArray<Field extends SegmentStateField>(
  field: Field
): (typeof segmentArrayByField)[Field] {
  return segmentArrayByField[field];
}

function bitWidthByteLength(width: StateStorageWidth): LayoutByteLength {
  switch (width) {
    case 8:
      return 1;
    case 16:
      return 2;
    case 32:
      return 4;
  }
}

function powerOfTwoShift(value: number): number {
  assert(
    Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0,
    `execution-state array stride must be a positive power of two, got ${value}`
  );
  return Math.log2(value);
}
