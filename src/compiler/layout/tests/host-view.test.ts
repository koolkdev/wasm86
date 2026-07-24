import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { createLayoutHostView } from "#compiler/layout/host-view.js";
import { ArrayRef, FieldRef } from "#compiler/layout/handles.js";
import { createLayout } from "#compiler/layout/layout.js";
import { layoutStructure } from "#compiler/layout/structure.js";

const fields = {
  byte: new FieldRef("host-view.fields.byte", "u8"),
  word: new FieldRef("host-view.fields.word", "u16"),
  doubleWord: new FieldRef("host-view.fields.double-word", "u32")
} as const;

const arrays = {
  bytes: new ArrayRef("host-view.arrays.bytes", "u8", ["first", "second"]),
  words: new ArrayRef("host-view.arrays.words", "u16", ["first", "second"]),
  doubleWords: new ArrayRef(
    "host-view.arrays.double-words",
    "u32",
    ["first", "second"]
  )
} as const;

const layout = createLayout("host-view.test", [
  layoutStructure("host-view.fields", Object.values(fields)),
  layoutStructure("host-view.arrays", Object.values(arrays))
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
  strictEqual(
    view.getUint32(layout.field(fields.doubleWord).offset, true),
    0x2345_6789
  );
});

test("layout host arrays resolve typed element identities and widths", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const storage = createLayoutHostView(memory, layout);

  storage.writeArrayElement(arrays.bytes, "second", 0x1fe);
  storage.writeArrayElement(arrays.words, "second", 0x1_abcd);
  storage.writeArrayElement(arrays.doubleWords, "second", 0x1_89ab_cdef);

  strictEqual(storage.readArrayElement(arrays.bytes, "first"), 0);
  strictEqual(storage.readArrayElement(arrays.bytes, "second"), 0xfe);
  strictEqual(storage.readArrayElement(arrays.words, "first"), 0);
  strictEqual(storage.readArrayElement(arrays.words, "second"), 0xabcd);
  strictEqual(storage.readArrayElement(arrays.doubleWords, "first"), 0);
  strictEqual(
    storage.readArrayElement(arrays.doubleWords, "second"),
    0x89ab_cdef
  );

  const view = new DataView(memory.buffer);
  const bytes = layout.array(arrays.bytes);
  const words = layout.array(arrays.words);
  const doubleWords = layout.array(arrays.doubleWords);

  strictEqual(view.getUint8(bytes.offset + bytes.stride), 0xfe);
  strictEqual(view.getUint16(words.offset + words.stride, true), 0xabcd);
  strictEqual(
    view.getUint32(doubleWords.offset + doubleWords.stride, true),
    0x89ab_cdef
  );
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
