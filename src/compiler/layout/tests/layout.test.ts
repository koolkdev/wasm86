import { deepStrictEqual, notDeepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { ArrayRef, FieldRef, NamedArrayRef } from "#compiler/layout/handles.js";
import { createLayout } from "#compiler/layout/layout.js";
import { layoutStructure } from "#compiler/layout/structure.js";

function exampleDefinition(prefix = "example") {
  const byte = new FieldRef(`${prefix}.state.byte`, "u8");
  const word = new FieldRef(`${prefix}.state.word`, "u32");
  const array = new NamedArrayRef(`${prefix}.state.array`, "u16", ["first", "second", "third"]);
  const tail = new FieldRef(`${prefix}.tail.value`, "u32");

  return {
    byte,
    word,
    array,
    tail,
    state: layoutStructure(`${prefix}.state`, [byte, word, array]),
    tailState: layoutStructure(`${prefix}.tail`, [tail])
  };
}

test("independently declared equal definitions resolve equally", () => {
  const first = exampleDefinition();
  const second = exampleDefinition();

  deepStrictEqual(
    createLayout("layout.test", [first.state, first.tailState]).record,
    createLayout("layout.test", [second.state, second.tailState]).record
  );
});

test("structure argument order does not affect the resolved record", () => {
  const definition = exampleDefinition();

  deepStrictEqual(
    createLayout("layout.test", [definition.state, definition.tailState]).record,
    createLayout("layout.test", [definition.tailState, definition.state]).record
  );
});

test("member width and explicit sequence affect resolved placement", () => {
  const original = exampleDefinition("original");
  const reorderedByte = new FieldRef("reordered.state.byte", "u8");
  const reorderedWord = new FieldRef("reordered.state.word", "u32");
  const reorderedArray = new NamedArrayRef("reordered.state.array", "u16", [
    "first",
    "second",
    "third"
  ]);
  const reordered = layoutStructure("reordered.state", [
    reorderedWord,
    reorderedByte,
    reorderedArray
  ]);
  const wideByte = new FieldRef("wide.state.byte", "u16");
  const wideWord = new FieldRef("wide.state.word", "u32");
  const wideArray = new NamedArrayRef("wide.state.array", "u16", ["first", "second", "third"]);
  const wide = layoutStructure("wide.state", [wideByte, wideWord, wideArray]);
  const originalLayout = createLayout("layout.test", [original.state]);
  const reorderedLayout = createLayout("layout.test", [reordered]);
  const wideLayout = createLayout("layout.test", [wide]);

  notDeepStrictEqual(
    [originalLayout.field(original.byte), originalLayout.field(original.word)],
    [reorderedLayout.field(reorderedByte), reorderedLayout.field(reorderedWord)]
  );
  notDeepStrictEqual(originalLayout.field(original.byte), wideLayout.field(wideByte));
});

test("declared element order is the indexing authority", () => {
  const first = new NamedArrayRef("array.state.values", "u32", ["eax", "ecx", "edx"]);
  const second = new NamedArrayRef("array.state.values", "u32", ["edx", "ecx", "eax"]);
  const firstLayout = createLayout("layout.test", [layoutStructure("array.state", [first])]);
  const secondLayout = createLayout("layout.test", [layoutStructure("array.state", [second])]);

  notDeepStrictEqual(
    firstLayout.namedArray(first).elementIds,
    secondLayout.namedArray(second).elementIds
  );
  strictEqual(first.elementIndex("eax"), 0);
  strictEqual(second.elementIndex("eax"), 2);
  strictEqual(second.elementIndex("edx"), 0);
});

test("resolution derives natural alignment, padding, array stride, and aggregate size", () => {
  const definition = exampleDefinition();
  const layout = createLayout("layout.test", [definition.state, definition.tailState]);

  // Structures sort as example.state then example.tail. The u32 member aligns
  // after the leading byte, and the u16 array remains contiguous.
  deepStrictEqual(layout.field(definition.byte), { offset: 0, byteLength: 1 });
  deepStrictEqual(layout.field(definition.word), { offset: 4, byteLength: 4 });
  deepStrictEqual(layout.namedArray(definition.array), {
    offset: 8,
    stride: 2,
    count: 3,
    elementByteLength: 2,
    elementIds: ["first", "second", "third"]
  });
  deepStrictEqual(layout.field(definition.tail), { offset: 16, byteLength: 4 });
  strictEqual(layout.alignment, 4);
  strictEqual(layout.byteLength, 20);
});

test("count-indexed arrays derive aligned placement, stride, count, and aggregate size", () => {
  const leadingByte = new FieldRef("indexed.state.leadingByte", "u8");
  const records = new ArrayRef("indexed.state.records", {
    count: 3,
    element: { byteLength: 6, alignment: 4 }
  });
  const trailingWord = new FieldRef("indexed.state.trailingWord", "u16");
  const layout = createLayout("layout.test", [
    layoutStructure("indexed.state", [leadingByte, records, trailingWord])
  ]);

  deepStrictEqual(layout.array(records), {
    offset: 4,
    stride: 8,
    count: 3,
    elementByteLength: 6,
    elementAlignment: 4
  });
  deepStrictEqual(layout.field(trailingWord), { offset: 28, byteLength: 2 });
  strictEqual(layout.alignment, 4);
  strictEqual(layout.byteLength, 32);
});

test("the resolved record enumerates count-indexed array placement facts", () => {
  const records = new ArrayRef("indexed.records.entries", {
    count: 3,
    element: { byteLength: 6, alignment: 4 }
  });

  deepStrictEqual(
    createLayout("layout.test", [layoutStructure("indexed.records", [records])]).record,
    {
      space: "layout.test",
      byteLength: 24,
      alignment: 4,
      structures: [
        {
          id: "indexed.records",
          members: [
            {
              kind: "array",
              id: "indexed.records.entries",
              offset: 0,
              stride: 8,
              count: 3,
              elementByteLength: 6,
              elementAlignment: 4
            }
          ]
        }
      ]
    }
  );
});

test("the resolved record enumerates canonical structures and placement facts", () => {
  const definition = exampleDefinition();

  deepStrictEqual(createLayout("layout.test", [definition.tailState, definition.state]).record, {
    space: "layout.test",
    byteLength: 20,
    alignment: 4,
    structures: [
      {
        id: "example.state",
        members: [
          { kind: "field", id: "example.state.byte", offset: 0, byteLength: 1 },
          { kind: "field", id: "example.state.word", offset: 4, byteLength: 4 },
          {
            kind: "namedArray",
            id: "example.state.array",
            offset: 8,
            stride: 2,
            elementByteLength: 2,
            elementIds: ["first", "second", "third"]
          }
        ]
      },
      {
        id: "example.tail",
        members: [{ kind: "field", id: "example.tail.value", offset: 16, byteLength: 4 }]
      }
    ]
  });
});
