import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { ByteSink } from "#compiler/encoder/byte-sink.js";

test("ByteSink prefixes section content and UTF-8 names", () => {
  const sink = new ByteSink();

  sink.writeSection(3, (section) => {
    section.writeName("Aé");
    section.writeU32(128);
  });

  deepStrictEqual([...sink.toBytes()], [
    0x03, 0x06,
    0x03, 0x41, 0xc3, 0xa9,
    0x80, 0x01
  ]);
});

test("ByteSink rejects invalid bytes and empty names", () => {
  const sink = new ByteSink();

  throws(() => sink.writeByte(-1), RangeError);
  throws(() => sink.writeByte(0x100), RangeError);
  throws(() => sink.writeName(""), /must not be empty/);
});
