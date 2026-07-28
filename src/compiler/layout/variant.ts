import { assert } from "#common/assert.js";
import {
  widthByteLength,
  type ByteLengthOf,
  type LayoutByteLength,
  type LayoutWidth
} from "./handles.js";
import { assertId, assertScopedId, compareIds } from "./ids.js";

// Variant and payload-field references are opaque identities to consumers.
// Stable IDs and widths describe independently reproducible definitions;
// resolved tags and placement are available only through VariantLayout.
export class VariantFieldRef<TWidth extends LayoutWidth = LayoutWidth> {
  readonly kind = "variantField";

  constructor(
    readonly id: string,
    readonly width: TWidth
  ) {}
}

export class VariantRef {
  readonly kind = "variant";

  constructor(
    readonly id: string,
    readonly fields: readonly VariantFieldRef[]
  ) {}
}

export type VariantSet = Readonly<{
  id: string;
  variants: readonly VariantRef[];
}>;

export function variantSet(id: string, variants: readonly VariantRef[]): VariantSet {
  return { id, variants };
}

export type VariantLayoutField<TWidth extends LayoutWidth = LayoutWidth> = Readonly<{
  offset: number;
  byteLength: ByteLengthOf<TWidth>;
}>;

export type VariantPlacement = Readonly<{
  tag: number;
  payloadByteLength: number;
}>;

export type VariantFieldRecord = Readonly<{
  id: string;
  offset: number;
  byteLength: LayoutByteLength;
}>;

export type VariantRecord = Readonly<{
  id: string;
  tag: number;
  payloadByteLength: number;
  fields: readonly VariantFieldRecord[];
}>;

export type VariantSetRecord = Readonly<{
  id: string;
  variants: readonly VariantRecord[];
}>;

// The complete resolved record. Sets and variants are in stable-id order,
// while each variant retains its owner's explicit field sequence. It carries
// no live handles.
export type VariantLayoutRecord = Readonly<{
  id: string;
  byteLength: number;
  tagOffset: number;
  sets: readonly VariantSetRecord[];
}>;

export interface VariantLayout {
  readonly id: string;
  readonly byteLength: number;
  readonly tagOffset: number;
  readonly record: VariantLayoutRecord;

  variant(ref: VariantRef): VariantPlacement;
  variantForTag(tag: number): VariantRef;
  field<TWidth extends LayoutWidth>(ref: VariantFieldRef<TWidth>): VariantLayoutField<TWidth>;
}

class VariantLayoutImpl implements VariantLayout {
  readonly #variants: ReadonlyMap<VariantRef, VariantPlacement>;
  readonly #variantsByTag: ReadonlyMap<number, VariantRef>;
  readonly #fields: ReadonlyMap<VariantFieldRef, VariantLayoutField>;

  constructor(
    readonly record: VariantLayoutRecord,
    variants: ReadonlyMap<VariantRef, VariantPlacement>,
    variantsByTag: ReadonlyMap<number, VariantRef>,
    fields: ReadonlyMap<VariantFieldRef, VariantLayoutField>
  ) {
    this.#variants = variants;
    this.#variantsByTag = variantsByTag;
    this.#fields = fields;
  }

  get id(): string {
    return this.record.id;
  }

  get byteLength(): number {
    return this.record.byteLength;
  }

  get tagOffset(): number {
    return this.record.tagOffset;
  }

  variant(ref: VariantRef): VariantPlacement {
    const variant = this.#variants.get(ref);

    assert(variant !== undefined, `variant ${ref.id} does not belong to the ${this.id} layout`);
    return variant;
  }

  variantForTag(tag: number): VariantRef {
    const variant = this.#variantsByTag.get(tag);

    if (variant === undefined) {
      throw new RangeError(`unknown ${this.id} variant tag: ${tag}`);
    }
    return variant;
  }

  field<TWidth extends LayoutWidth>(ref: VariantFieldRef<TWidth>): VariantLayoutField<TWidth> {
    const field = this.#fields.get(ref);

    assert(field !== undefined, `variant field ${ref.id} does not belong to the ${this.id} layout`);
    return field as VariantLayoutField<TWidth>;
  }
}

export function createVariantLayout(id: string, sets: readonly VariantSet[]): VariantLayout {
  assertId(id, "variant layout id");
  assert(sets.length > 0, `variant layout ${id} has no sets`);

  const setIds = new Set<string>();
  const variantIds = new Set<string>();
  const fieldIds = new Set<string>();

  for (const set of sets) {
    assertScopedId(set.id, "variant set id");
    assert(!setIds.has(set.id), `duplicate variant set id: ${set.id}`);
    setIds.add(set.id);
    assert(set.variants.length > 0, `variant set ${set.id} has no variants`);

    for (const variant of set.variants) {
      assertScopedId(variant.id, "variant id");
      assert(!variantIds.has(variant.id), `duplicate variant id: ${variant.id}`);
      variantIds.add(variant.id);

      for (const field of variant.fields) {
        assertScopedId(field.id, "variant field id");
        assert(!fieldIds.has(field.id), `duplicate variant field id: ${field.id}`);
        fieldIds.add(field.id);
      }
    }
  }

  assert(variantIds.size <= 0xff, `variant layout ${id} has too many variants: ${variantIds.size}`);

  const orderedSets = [...sets]
    .sort((left, right) => compareIds(left.id, right.id))
    .map((set) => ({
      set,
      variants: [...set.variants].sort((left, right) => compareIds(left.id, right.id))
    }));
  const variants = new Map<VariantRef, VariantPlacement>();
  const variantsByTag = new Map<number, VariantRef>();
  const fields = new Map<VariantFieldRef, VariantLayoutField>();
  const records = new Map<VariantRef, VariantRecord>();
  let tag = 1;
  let maximumPayloadByteLength = 0;

  for (const { variants: orderedVariants } of orderedSets) {
    for (const variant of orderedVariants) {
      let offset = 0;
      const fieldRecords: VariantFieldRecord[] = [];

      for (const field of variant.fields) {
        const byteLength = widthByteLength(field.width);

        offset = alignUp(offset, byteLength);
        const placement = { offset, byteLength };

        fields.set(field, placement);
        fieldRecords.push({ id: field.id, offset, byteLength });
        offset += byteLength;
      }

      const placement = { tag, payloadByteLength: offset };

      variants.set(variant, placement);
      variantsByTag.set(tag, variant);
      records.set(variant, {
        id: variant.id,
        tag,
        payloadByteLength: offset,
        fields: fieldRecords
      });
      maximumPayloadByteLength = Math.max(maximumPayloadByteLength, offset);
      tag += 1;
    }
  }

  const record: VariantLayoutRecord = {
    id,
    byteLength: maximumPayloadByteLength + 1,
    tagOffset: maximumPayloadByteLength,
    sets: orderedSets.map(({ set, variants: orderedVariants }) => ({
      id: set.id,
      variants: orderedVariants.map((variant) => {
        const record = records.get(variant);

        assert(record !== undefined, `unresolved variant: ${variant.id}`);
        return record;
      })
    }))
  };

  assert(
    record.byteLength <= 8,
    `variant layout ${id} does not fit an i64: ${record.byteLength} bytes`
  );

  return new VariantLayoutImpl(record, variants, variantsByTag, fields);
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
