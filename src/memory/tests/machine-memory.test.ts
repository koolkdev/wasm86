import { strictEqual } from "node:assert";
import { test } from "node:test";

import { createMachineMemoryDefinition } from "#memory/machine-memory.js";
import { pageTableEntries } from "#memory/virtual/layout.js";

test("machine memory includes the complete Virtual page table", () => {
  const definition = createMachineMemoryDefinition();
  const entries = definition.layout.array(pageTableEntries);

  strictEqual(entries.count, 0x10_0000);
  strictEqual(entries.elementByteLength, 4);
  strictEqual(entries.elementAlignment, 4);
  strictEqual(definition.memoryImport.limits.minPages, 64);
  strictEqual(definition.memoryImport.ref, definition.resource);
});
