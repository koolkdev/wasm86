import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import { writeBackingBytes } from "#memory/bytes.js";
import { guestMemoryAccess } from "#memory/access.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";

test("flat instruction fetch resolves before reading its backing byte", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const access = guestMemoryAccess.bindHost(memory);

  writeBackingBytes(memory, guestMemoryMinimumByteLength - 1, [0xa5]);

  const resolved = access.resolveByte(
    guestMemoryMinimumByteLength - 1,
    "instructionFetch"
  );

  deepStrictEqual(resolved, {
    kind: "access",
    access: {
      address: guestMemoryMinimumByteLength - 1,
      intent: "instructionFetch"
    }
  });
  if (resolved.kind === "access") {
    deepStrictEqual(access.readByte(resolved.access), 0xa5);
  }
  deepStrictEqual(
    access.resolveByte(
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
  const access = guestMemoryAccess.bindHost(memory);

  memory.grow(1);
  writeBackingBytes(memory, guestMemoryMinimumByteLength, [0x90]);

  deepStrictEqual(
    access.resolveByte(
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

test("flat instruction fetch rejects an invalid Memory binding", () => {
  throws(
    () => guestMemoryAccess.bindHost(new WebAssembly.Memory({ initial: 0 })),
    /guest memory is shorter than the flat address-space binding/
  );
});
