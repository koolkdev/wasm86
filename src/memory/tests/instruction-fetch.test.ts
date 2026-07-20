import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { writeBackingBytes } from "#memory/bytes.js";
import { guestMemoryAccess } from "#memory/access.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";

test("flat instruction fetch checks and reads its backing byte", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const reader = guestMemoryAccess.bindHost(memory);

  writeBackingBytes(memory, guestMemoryMinimumByteLength - 1, [0xa5]);

  deepStrictEqual(
    reader.readByte(
      guestMemoryMinimumByteLength - 1,
      "instructionFetch"
    ),
    { kind: "value", value: 0xa5 }
  );
  deepStrictEqual(
    reader.readByte(
      guestMemoryMinimumByteLength,
      "instructionFetch"
    ),
    {
      kind: "exception",
      exception: pageFault(
        guestMemoryMinimumByteLength,
        PageFaultErrorCode.INSTRUCTION_FETCH
      )
    }
  );
});

test("flat instruction fetch keeps its address-space boundary after growth", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const reader = guestMemoryAccess.bindHost(memory);

  memory.grow(1);
  writeBackingBytes(memory, guestMemoryMinimumByteLength, [0x90]);

  deepStrictEqual(
    reader.readByte(
      guestMemoryMinimumByteLength,
      "instructionFetch"
    ),
    {
      kind: "exception",
      exception: pageFault(
        guestMemoryMinimumByteLength,
        PageFaultErrorCode.INSTRUCTION_FETCH
      )
    }
  );
});

test("host byte reads retain data-read fault intent", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const reader = guestMemoryAccess.bindHost(memory);

  deepStrictEqual(
    reader.readByte(guestMemoryMinimumByteLength, "read"),
    {
      kind: "exception",
      exception: pageFault(guestMemoryMinimumByteLength, 0)
    }
  );
});

test("flat instruction fetch rejects an invalid Memory binding", () => {
  throws(
    () => guestMemoryAccess.bindHost(new WebAssembly.Memory({ initial: 0 })),
    /guest memory is shorter than the flat address-space binding/
  );
});
