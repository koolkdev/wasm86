import { assert } from "#common/assert.js";
import type { ValueWidthForStorage } from "#compiler/function/resource.js";
import {
  widthByteLength,
  type AnyFieldRef,
  type ArrayRef,
  type ByteLengthOf,
  type FieldRef,
  type LayoutByteLength,
  type LayoutBitWidth,
  type LayoutMember,
  type LayoutWidth,
  type NamedArrayRef
} from "./handles.js";
import { assertId, assertScopedId, compareIds } from "./ids.js";
import type { LayoutStructure } from "./structure.js";

export type LayoutField<TWidth extends LayoutWidth = LayoutWidth> = Readonly<{
  offset: number;
  byteLength: ByteLengthOf<TWidth>;
}>;

export type LayoutNamedArray<
  TWidth extends LayoutWidth = LayoutWidth,
  TElementId extends string = string
> = Readonly<{
  offset: number;
  stride: number;
  count: number;
  elementByteLength: ByteLengthOf<TWidth>;
  elementIds: readonly TElementId[];
}>;

export type LayoutArray = Readonly<{
  offset: number;
  stride: number;
  count: number;
  elementByteLength: number;
  elementAlignment: number;
}>;

export type LayoutRecordMember =
  | Readonly<{
      kind: "field";
      id: string;
      offset: number;
      byteLength: LayoutByteLength;
    }>
  | Readonly<{
      kind: "namedArray";
      id: string;
      offset: number;
      stride: number;
      elementByteLength: LayoutByteLength;
      elementIds: readonly string[];
    }>
  | Readonly<{
      kind: "array";
      id: string;
      offset: number;
      stride: number;
      count: number;
      elementByteLength: number;
      elementAlignment: number;
    }>;

export type LayoutRecordStructure = Readonly<{
  id: string;
  members: readonly LayoutRecordMember[];
}>;

// The complete resolved record: structures in stable id order, members in
// their declared sequences, and every placement fact enumerable. It carries
// no live handles.
export type LayoutRecord = Readonly<{
  space: string;
  byteLength: number;
  alignment: number;
  structures: readonly LayoutRecordStructure[];
}>;

// A layout describes one storage space: execution state today, machine
// memory (descriptors, page tables) when its first consumer lands. The space
// is stable identity, not module layout — import names and memory indexes
// stay with Wasm module indexing.
export interface Layout {
  readonly space: string;
  readonly byteLength: number;
  readonly alignment: number;
  readonly record: LayoutRecord;

  field<
    TWidth extends LayoutWidth,
    TValueWidth extends ValueWidthForStorage<LayoutBitWidth<TWidth>>
  >(
    ref: FieldRef<TWidth, TValueWidth>
  ): LayoutField<TWidth>;
  namedArray<TWidth extends LayoutWidth, TElementId extends string>(
    ref: NamedArrayRef<TWidth, TElementId>
  ): LayoutNamedArray<TWidth, TElementId>;
  array(ref: ArrayRef): LayoutArray;
}

class LayoutImpl implements Layout {
  readonly #fields: ReadonlyMap<AnyFieldRef, LayoutField>;
  readonly #namedArrays: ReadonlyMap<NamedArrayRef, LayoutNamedArray>;
  readonly #arrays: ReadonlyMap<ArrayRef, LayoutArray>;

  constructor(
    readonly record: LayoutRecord,
    fields: ReadonlyMap<AnyFieldRef, LayoutField>,
    namedArrays: ReadonlyMap<NamedArrayRef, LayoutNamedArray>,
    arrays: ReadonlyMap<ArrayRef, LayoutArray>
  ) {
    this.#fields = fields;
    this.#namedArrays = namedArrays;
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

  field<
    TWidth extends LayoutWidth,
    TValueWidth extends ValueWidthForStorage<LayoutBitWidth<TWidth>>
  >(ref: FieldRef<TWidth, TValueWidth>): LayoutField<TWidth> {
    const field = this.#fields.get(ref as AnyFieldRef);

    assert(field !== undefined, `field ${ref.id} does not belong to the ${this.space} layout`);
    return field as LayoutField<TWidth>;
  }

  namedArray<TWidth extends LayoutWidth, TElementId extends string>(
    ref: NamedArrayRef<TWidth, TElementId>
  ): LayoutNamedArray<TWidth, TElementId> {
    const array = this.#namedArrays.get(ref);

    assert(
      array !== undefined,
      `named array ${ref.id} does not belong to the ${this.space} layout`
    );
    return array as LayoutNamedArray<TWidth, TElementId>;
  }

  array(ref: ArrayRef): LayoutArray {
    const array = this.#arrays.get(ref);

    assert(array !== undefined, `array ${ref.id} does not belong to the ${this.space} layout`);
    return array;
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

  const orderedStructures = [...structures].sort((left, right) => compareIds(left.id, right.id));
  const fields = new Map<AnyFieldRef, LayoutField>();
  const namedArrays = new Map<NamedArrayRef, LayoutNamedArray>();
  const arrays = new Map<ArrayRef, LayoutArray>();
  let offset = 0;
  let alignment = 1;

  for (const structure of orderedStructures) {
    for (const member of structure.members) {
      switch (member.kind) {
        case "field": {
          const byteLength = widthByteLength(member.width);

          alignment = Math.max(alignment, byteLength);
          offset = alignUp(offset, byteLength);
          fields.set(member, { offset, byteLength });
          offset += byteLength;
          break;
        }
        case "namedArray": {
          const elementByteLength = widthByteLength(member.elementWidth);
          const stride = elementByteLength;

          alignment = Math.max(alignment, elementByteLength);
          offset = alignUp(offset, elementByteLength);
          namedArrays.set(member, {
            offset,
            stride,
            count: member.count,
            elementByteLength,
            elementIds: member.elementIds
          });
          offset += stride * member.count;
          break;
        }
        case "array": {
          const elementByteLength = member.element.byteLength;
          const elementAlignment = member.element.alignment;
          const stride = alignUp(elementByteLength, elementAlignment);
          const arrayByteLength = stride * member.count;

          assert(
            Number.isSafeInteger(stride) && Number.isSafeInteger(arrayByteLength),
            `layout array ${member.id} exceeds the safe integer range`
          );
          alignment = Math.max(alignment, elementAlignment);
          offset = alignUp(offset, elementAlignment);
          arrays.set(member, {
            offset,
            stride,
            count: member.count,
            elementByteLength,
            elementAlignment
          });
          offset += arrayByteLength;
          break;
        }
      }

      assert(Number.isSafeInteger(offset), `layout ${space} exceeds the safe integer range`);
    }
  }

  const byteLength = alignUp(offset, alignment);

  assert(Number.isSafeInteger(byteLength), `layout ${space} exceeds the safe integer range`);
  const record: LayoutRecord = {
    space,
    byteLength,
    alignment,
    structures: orderedStructures.map((structure) => ({
      id: structure.id,
      members: structure.members.map((member) => memberRecord(member, fields, namedArrays, arrays))
    }))
  };

  return new LayoutImpl(record, fields, namedArrays, arrays);
}

function memberRecord(
  member: LayoutMember,
  fields: ReadonlyMap<AnyFieldRef, LayoutField>,
  namedArrays: ReadonlyMap<NamedArrayRef, LayoutNamedArray>,
  arrays: ReadonlyMap<ArrayRef, LayoutArray>
): LayoutRecordMember {
  switch (member.kind) {
    case "field": {
      const field = fields.get(member);

      assert(field !== undefined, `unplaced layout field: ${member.id}`);
      return { kind: "field", id: member.id, offset: field.offset, byteLength: field.byteLength };
    }
    case "namedArray": {
      const array = namedArrays.get(member);

      assert(array !== undefined, `unplaced named layout array: ${member.id}`);
      return {
        kind: "namedArray",
        id: member.id,
        offset: array.offset,
        stride: array.stride,
        elementByteLength: array.elementByteLength,
        elementIds: array.elementIds
      };
    }
    case "array": {
      const array = arrays.get(member);

      assert(array !== undefined, `unplaced layout array: ${member.id}`);
      return {
        kind: "array",
        id: member.id,
        offset: array.offset,
        stride: array.stride,
        count: array.count,
        elementByteLength: array.elementByteLength,
        elementAlignment: array.elementAlignment
      };
    }
  }
}

function validateMember(member: LayoutMember): void {
  assertScopedId(member.id, `${member.kind} member id`);

  switch (member.kind) {
    case "field":
      return;
    case "array":
      assert(
        Number.isSafeInteger(member.count) && member.count > 0,
        `layout array ${member.id} must have a positive safe-integer count`
      );
      assert(
        Number.isSafeInteger(member.element.byteLength) && member.element.byteLength > 0,
        `layout array ${member.id} must have a positive safe-integer element byte length`
      );
      assert(
        Number.isSafeInteger(member.element.alignment) &&
          member.element.alignment > 0 &&
          Number.isInteger(Math.log2(member.element.alignment)),
        `layout array ${member.id} must have a positive power-of-two element alignment`
      );
      return;
    case "namedArray": {
      assert(member.elementIds.length > 0, `named layout array ${member.id} has no elements`);

      const elementIds = new Set<string>();

      for (const elementId of member.elementIds) {
        assert(elementId.length > 0, `named layout array ${member.id} has an empty element id`);
        assert(
          !elementIds.has(elementId),
          `named layout array ${member.id} has duplicate element id: ${elementId}`
        );
        elementIds.add(elementId);
      }
      return;
    }
  }
}

function alignUp(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
