import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { ArrayRef, FieldRef, NamedArrayRef } from "#compiler/layout/handles.js";
import { createLayout } from "#compiler/layout/layout.js";
import { layoutStructure } from "#compiler/layout/structure.js";

const fields = {
  byte: new FieldRef("host-view.fields.byte", "u8"),
  word: new FieldRef("host-view.fields.word", "u16"),
  doubleWord: new FieldRef("host-view.fields.double-word", "u32")
} as const;

const namedArrays = {
  bytes: new NamedArrayRef("host-view.arrays.bytes", "u8", ["first", "second"]),
  words: new NamedArrayRef("host-view.arrays.words", "u16", ["first", "second"]),
  doubleWords: new NamedArrayRef("host-view.arrays.double-words", "u32", ["first", "second"])
} as const;

const records = new ArrayRef("host-view.records.entries", {
  count: 2,
  element: { byteLength: 6, alignment: 4 }
});

const layout = createLayout("host-view.test", [
  layoutStructure("host-view.fields", Object.values(fields)),
  layoutStructure("host-view.arrays", Object.values(namedArrays))
]);
const recordLayout = createLayout("host-view.records", [
  layoutStructure("host-view.records", [records])
]);

test("layout host fields use their declared unsigned widths", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const storage = createLayoutHostView(memory, layout);

  storage.writeField(fields.byte, 0x1ab);
  storage.writeField(fields.word, 0x1_2345);
  storage.writeField(fields.doubleWord, 0x1_2345_6789);

  strictEqual(storage.readField(fields.byte), 0xab);
  strictEqual(storage.readField(fields.word), 0x2345);
  strictEqual(storage.readField(fields.doubleWord), 0x2345_6789);

  const view = new DataView(memory.buffer);

  strictEqual(view.getUint8(layout.field(fields.byte).offset), 0xab);
  strictEqual(view.getUint16(layout.field(fields.word).offset, true), 0x2345);
  strictEqual(view.getUint32(layout.field(fields.doubleWord).offset, true), 0x2345_6789);
});

test("layout host named arrays resolve typed element identities and widths", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const storage = createLayoutHostView(memory, layout);

  storage.writeNamedArrayElement(namedArrays.bytes, "second", 0x1fe);
  storage.writeNamedArrayElement(namedArrays.words, "second", 0x1_abcd);
  storage.writeNamedArrayElement(namedArrays.doubleWords, "second", 0x1_89ab_cdef);

  strictEqual(storage.readNamedArrayElement(namedArrays.bytes, "first"), 0);
  strictEqual(storage.readNamedArrayElement(namedArrays.bytes, "second"), 0xfe);
  strictEqual(storage.readNamedArrayElement(namedArrays.words, "first"), 0);
  strictEqual(storage.readNamedArrayElement(namedArrays.words, "second"), 0xabcd);
  strictEqual(storage.readNamedArrayElement(namedArrays.doubleWords, "first"), 0);
  strictEqual(storage.readNamedArrayElement(namedArrays.doubleWords, "second"), 0x89ab_cdef);

  const view = new DataView(memory.buffer);
  const bytes = layout.namedArray(namedArrays.bytes);
  const words = layout.namedArray(namedArrays.words);
  const doubleWords = layout.namedArray(namedArrays.doubleWords);

  strictEqual(view.getUint8(bytes.offset + bytes.stride), 0xfe);
  strictEqual(view.getUint16(words.offset + words.stride, true), 0xabcd);
  strictEqual(view.getUint32(doubleWords.offset + doubleWords.stride, true), 0x89ab_cdef);
});

test("layout host arrays access record-relative fields across memory growth", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const storage = createLayoutHostView(memory, recordLayout);
  const initialBuffer = memory.buffer;

  storage.writeArrayElement(records, 1, 0, 2, 0xabcd);
  storage.writeArrayElement(records, 1, 2, 4, 0x1234_5678);
  memory.grow(1);

  notStrictEqual(memory.buffer, initialBuffer);
  strictEqual(storage.readArrayElement(records, 1, 0, 2), 0xabcd);
  strictEqual(storage.readArrayElement(records, 1, 2, 4), 0x1234_5678);
  storage.writeArrayElement(records, 1, 2, 4, 0x89ab_cdef);

  const view = new DataView(memory.buffer);

  strictEqual(view.getUint16(8, true), 0xabcd);
  strictEqual(view.getUint32(10, true), 0x89ab_cdef);
  strictEqual(view.getUint16(14, true), 0);
});

test("layout host access refreshes its DataView after memory growth", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const storage = createLayoutHostView(memory, layout);
  const initialBuffer = memory.buffer;

  storage.writeField(fields.doubleWord, 0x1234_5678);
  memory.grow(1);

  notStrictEqual(memory.buffer, initialBuffer);
  strictEqual(storage.readField(fields.doubleWord), 0x1234_5678);

  storage.writeField(fields.doubleWord, 0x89ab_cdef);
  strictEqual(storage.readField(fields.doubleWord), 0x89ab_cdef);
});
