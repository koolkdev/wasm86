import { deepStrictEqual } from "node:assert";
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
