import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { encodeMemoryImmediate } from "#compiler/encoder/memory.js";

test("memory immediates encode default and indexed memories literally", () => {
  deepStrictEqual(
    encodeMemoryImmediate({ align: 2, memoryIndex: 0, offset: 7 }),
    [0x02, 0x07]
  );
  deepStrictEqual(
    encodeMemoryImmediate({ align: 2, memoryIndex: 1, offset: 0 }),
    [0x42, 0x01, 0x00]
  );
});

test("memory immediates reject invalid unsigned fields and alignment flags", () => {
  throws(
    () => encodeMemoryImmediate({ align: 0x40, memoryIndex: 0, offset: 0 }),
    /memory alignment must be below 64/
  );
  throws(
    () => encodeMemoryImmediate({ align: 0, memoryIndex: -1, offset: 0 }),
    /memory index out of range/
  );
  throws(
    () => encodeMemoryImmediate({ align: 0, memoryIndex: 0, offset: 1.5 }),
    /memory offset out of range/
  );
});
