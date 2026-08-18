import { assert } from "#common/assert.js";
import type { ValueWidthForStorage } from "#compiler/function/resource.js";

export type LayoutWidth = "u8" | "u16" | "u32";
export type LayoutByteLength = 1 | 2 | 4;

type ByteLengthByWidth = Readonly<{
  u8: 1;
  u16: 2;
  u32: 4;
}>;

type BitWidthByWidth = Readonly<{
  u8: 8;
  u16: 16;
  u32: 32;
}>;

export type ByteLengthOf<TWidth extends LayoutWidth> = ByteLengthByWidth[TWidth];
export type LayoutBitWidth<TWidth extends LayoutWidth> = BitWidthByWidth[TWidth];

const byteLengthByWidth: ByteLengthByWidth = {
  u8: 1,
  u16: 2,
  u32: 4
};

const bitWidthByWidth: BitWidthByWidth = {
  u8: 8,
  u16: 16,
  u32: 32
};

export function widthByteLength<TWidth extends LayoutWidth>(width: TWidth): ByteLengthOf<TWidth> {
  return byteLengthByWidth[width];
}

export function layoutBitWidth<TWidth extends LayoutWidth>(width: TWidth): LayoutBitWidth<TWidth> {
  return bitWidthByWidth[width];
}

// Layout references are opaque identities to consumers. Their stable IDs,
// storage widths, and logical value widths describe definitions; resolved
// placement remains available only through Layout.
export class FieldRef<
  TWidth extends LayoutWidth,
  TValueWidth extends ValueWidthForStorage<LayoutBitWidth<TWidth>> = LayoutBitWidth<TWidth>
> {
  readonly kind = "field";
  readonly valueWidth: TValueWidth;

  constructor(
    readonly id: string,
    readonly width: TWidth,
    ...valueWidth: LayoutBitWidth<TWidth> extends TValueWidth
      ? [valueWidth?: TValueWidth]
      : [valueWidth: TValueWidth]
  ) {
    this.valueWidth =
      valueWidth[0] ?? (layoutBitWidth(width) as LayoutBitWidth<TWidth> & TValueWidth);
  }
}

export function bitField(id: string): FieldRef<"u8", 1> {
  return new FieldRef(id, "u8", 1);
}

export type AnyFieldRef = {
  readonly [Width in LayoutWidth]: FieldRef<Width, ValueWidthForStorage<LayoutBitWidth<Width>>>;
}[LayoutWidth];

export class NamedArrayRef<
  TWidth extends LayoutWidth = LayoutWidth,
  TElementId extends string = string
> {
  readonly kind = "namedArray";
  readonly #elementIndexes: ReadonlyMap<TElementId, number>;

  constructor(
    readonly id: string,
    readonly elementWidth: TWidth,
    readonly elementIds: readonly TElementId[]
  ) {
    this.#elementIndexes = new Map(elementIds.map((elementId, index) => [elementId, index]));
  }

  get count(): number {
    return this.elementIds.length;
  }

  // The declared element order is the indexing authority for every static
  // consumer; dynamic runtime indexes must follow the same architectural
  // order by owner declaration.
  elementIndex(elementId: TElementId): number {
    const index = this.#elementIndexes.get(elementId);

    assert(index !== undefined, `unknown element ${elementId} in named layout array ${this.id}`);
    return index;
  }
}

export type ArrayElementLayout = Readonly<{
  byteLength: number;
  alignment: number;
}>;

export type ArrayDefinition<TElement extends ArrayElementLayout = ArrayElementLayout> = Readonly<{
  count: number;
  element: Readonly<TElement>;
}>;

export class ArrayRef<TElement extends ArrayElementLayout = ArrayElementLayout> {
  readonly kind = "array";
  readonly count: number;
  readonly element: Readonly<TElement>;

  constructor(
    readonly id: string,
    definition: ArrayDefinition<TElement>
  ) {
    this.count = definition.count;
    this.element = definition.element;
  }
}

export type LayoutMember = AnyFieldRef | NamedArrayRef | ArrayRef;
