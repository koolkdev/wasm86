import { assert } from "#common/assert.js";

export type LayoutWidth = "u8" | "u16" | "u32";
export type LayoutByteLength = 1 | 2 | 4;

export type ByteLengthOf<TWidth extends LayoutWidth> = TWidth extends "u8"
  ? 1
  : TWidth extends "u16"
    ? 2
    : 4;

export function widthByteLength(width: LayoutWidth): LayoutByteLength {
  switch (width) {
    case "u8":
      return 1;
    case "u16":
      return 2;
    case "u32":
      return 4;
  }
}

// Layout references are opaque identities to consumers. Their stable IDs and
// scalar widths describe definitions for deterministic composition; resolved
// placement remains available only through Layout.
export class FieldRef<TWidth extends LayoutWidth = LayoutWidth> {
  readonly kind = "field";

  constructor(
    readonly id: string,
    readonly width: TWidth
  ) {}
}

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

export type LayoutMember = FieldRef | NamedArrayRef | ArrayRef;
