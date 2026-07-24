import { strictEqual } from "node:assert";
import { test } from "node:test";

import { writeBackingBytes } from "#memory/bytes.js";
import { createPhysicalAddressSpaceDefinition } from "#memory/physical.js";

test("bound Physical reads follow the live RAM backing across growth", () => {
  const physical = createPhysicalAddressSpaceDefinition();
  const ram = new WebAssembly.Memory({
    initial: physical.ramImport.limits.minPages
  });
  const initialAddress = ram.buffer.byteLength - 1;
  const grownAddress = ram.buffer.byteLength;
  const bound = physical.bindHost({ ram });

  writeBackingBytes(ram, initialAddress, [0xa5]);

  strictEqual(bound.reader.readByte(initialAddress), 0xa5);

  ram.grow(1);
  writeBackingBytes(ram, grownAddress, [0x5a]);

  strictEqual(bound.reader.readByte(grownAddress), 0x5a);
});
