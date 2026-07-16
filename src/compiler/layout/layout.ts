import { assert } from "#common/assert.js";
import {
  widthByteLength,
  type ArrayRef,
  type ByteLengthOf,
  type FieldRef,
  type LayoutByteLength,
  type LayoutMember,
  type LayoutWidth
} from "./handles.js";
import { assertId, assertScopedId, compareIds } from "./ids.js";
import type { LayoutStructure } from "./structure.js";

export type LayoutField<TWidth extends LayoutWidth = LayoutWidth> = Readonly<{
  offset: number;
  byteLength: ByteLengthOf<TWidth>;
}>;

export type LayoutArray<
  TWidth extends LayoutWidth = LayoutWidth,
  TElementId extends string = string
> = Readonly<{
  offset: number;
  stride: number;
  count: number;
  elementByteLength: ByteLengthOf<TWidth>;
  elementIds: readonly TElementId[];
}>;

export type LayoutRecordMember =
  | Readonly<{
      kind: "field";
      id: string;
      offset: number;
      byteLength: LayoutByteLength;
    }>
  | Readonly<{
      kind: "array";
      id: string;
      offset: number;
      stride: number;
      elementByteLength: LayoutByteLength;
      elementIds: readonly string[];
    }>;

export type LayoutRecordStructure = Readonly<{
  id: string;
  members: readonly LayoutRecordMember[];
}>;

// The complete canonical resolved record: structures in canonical id order,
// members in their declared sequences, every placement fact enumerable. It
// carries no handle or other object identity, so consumers can fingerprint it
// directly.
export type LayoutRecord = Readonly<{
  space: string;
  byteLength: number;
  alignment: number;
  structures: readonly LayoutRecordStructure[];
}>;

// A layout describes one storage space: execution state today, machine
// memory (descriptors, page tables) when its first consumer lands. The space
// is stable identity, not binding — import names and memory indexes stay
// with module binding.
export interface Layout {
  readonly space: string;
  readonly byteLength: number;
  readonly alignment: number;
  readonly record: LayoutRecord;

  field<TWidth extends LayoutWidth>(ref: FieldRef<TWidth>): LayoutField<TWidth>;
  array<TWidth extends LayoutWidth, TElementId extends string>(
    ref: ArrayRef<TWidth, TElementId>
  ): LayoutArray<TWidth, TElementId>;
}

class LayoutImpl implements Layout {
  readonly #fields: ReadonlyMap<FieldRef, LayoutField>;
  readonly #arrays: ReadonlyMap<ArrayRef, LayoutArray>;

  constructor(
    readonly record: LayoutRecord,
    fields: ReadonlyMap<FieldRef, LayoutField>,
    arrays: ReadonlyMap<ArrayRef, LayoutArray>
  ) {
    this.#fields = fields;
    this.#arrays = arrays;
  }

  get space(): string {
    return this.record.space;
  }

  get byteLength(): number {
    return this.record.byteLength;
  }

  get alignment(): number {
    return this.record.alignment;
  }

  field<TWidth extends LayoutWidth>(ref: FieldRef<TWidth>): LayoutField<TWidth> {
    const field = this.#fields.get(ref);

    assert(field !== undefined, `field ${ref.id} does not belong to the ${this.space} layout`);
    return field as LayoutField<TWidth>;
  }

  array<TWidth extends LayoutWidth, TElementId extends string>(
    ref: ArrayRef<TWidth, TElementId>
  ): LayoutArray<TWidth, TElementId> {
    const array = this.#arrays.get(ref);

    assert(array !== undefined, `array ${ref.id} does not belong to the ${this.space} layout`);
    return array as LayoutArray<TWidth, TElementId>;
  }
}

export function createLayout(space: string, structures: readonly LayoutStructure[]): Layout {
  const structureIds = new Set<string>();
  const memberIds = new Set<string>();

  assertId(space, "layout space");

  for (const structure of structures) {
    assertScopedId(structure.id, "structure id");
    assert(!structureIds.has(structure.id), `duplicate structure id: ${structure.id}`);
    structureIds.add(structure.id);
    assert(structure.members.length > 0, `layout structure ${structure.id} has no members`);

    for (const member of structure.members) {
      validateMember(member);
      assert(!memberIds.has(member.id), `duplicate layout member id: ${member.id}`);
      memberIds.add(member.id);
    }
  }

  const orderedStructures = [...structures].sort((left, right) =>
    compareIds(left.id, right.id)
  );
  const fields = new Map<FieldRef, LayoutField>();
  const arrays = new Map<ArrayRef, LayoutArray>();
  let offset = 0;
  let alignment = 1;

  for (const structure of orderedStructures) {
    for (const member of structure.members) {
      const byteLength = widthByteLength(memberWidth(member));

      alignment = Math.max(alignment, byteLength);
      offset = alignUp(offset, byteLength);

      if (member.kind === "field") {
        fields.set(member, { offset, byteLength });
        offset += byteLength;
      } else {
        const stride = alignUp(byteLength, byteLength);

        arrays.set(member, {
          offset,
          stride,
          count: member.count,
          elementByteLength: byteLength,
          elementIds: member.elementIds
        });
        offset += stride * member.count;
      }
    }
  }

  const record: LayoutRecord = {
    space,
    byteLength: alignUp(offset, alignment),
    alignment,
    structures: orderedStructures.map((structure) => ({
      id: structure.id,
      members: structure.members.map((member) => memberRecord(member, fields, arrays))
    }))
  };

  return new LayoutImpl(record, fields, arrays);
}

function memberRecord(
  member: LayoutMember,
  fields: ReadonlyMap<FieldRef, LayoutField>,
  arrays: ReadonlyMap<ArrayRef, LayoutArray>
): LayoutRecordMember {
  if (member.kind === "field") {
    const field = fields.get(member);

    assert(field !== undefined, `unplaced layout field: ${member.id}`);
    return { kind: "field", id: member.id, offset: field.offset, byteLength: field.byteLength };
  }

  const array = arrays.get(member);

  assert(array !== undefined, `unplaced layout array: ${member.id}`);
  return {
    kind: "array",
    id: member.id,
    offset: array.offset,
    stride: array.stride,
    elementByteLength: array.elementByteLength,
    elementIds: array.elementIds
  };
}

function validateMember(member: LayoutMember): void {
  assertScopedId(member.id, `${member.kind} member id`);

  if (member.kind === "array") {
    assert(member.elementIds.length > 0, `layout array ${member.id} has no elements`);

    const elementIds = new Set<string>();

    for (const elementId of member.elementIds) {
      assert(elementId.length > 0, `layout array ${member.id} has an empty element id`);
      assert(
        !elementIds.has(elementId),
        `layout array ${member.id} has duplicate element id: ${elementId}`
      );
      elementIds.add(elementId);
    }
  }
}

function memberWidth(member: LayoutMember): LayoutWidth {
  return member.kind === "field" ? member.width : member.elementWidth;
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
