import { notStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { wasmPagesForByteLength } from "#compiler/program/pages.js";
import { createExecutionModel } from "#execution/model.js";

test("execution model composes owner-provided definitions", () => {
  const model = createExecutionModel();

  strictEqual(model.resources.memoryImports[0], model.cpuState.memoryImport);
  strictEqual(model.resources.memoryImports[1], model.guestMemory.memoryImport);
  strictEqual(
    model.cpuState.memoryImport.limits.minPages,
    wasmPagesForByteLength(model.cpuState.layout.byteLength)
  );
  strictEqual(model.guestMemory.memoryImport.limits.minPages, 1);
});

test("execution models use distinct symbolic resource identities", () => {
  const first = createExecutionModel();
  const second = createExecutionModel();

  notStrictEqual(first.cpuState.resource, second.cpuState.resource);
  notStrictEqual(first.cpuState.access, second.cpuState.access);
  notStrictEqual(first.guestMemory.resource, second.guestMemory.resource);
  notStrictEqual(first.guestMemory.access, second.guestMemory.access);
  strictEqual(
    first.resources.memoryImports.some(
      (memory) => memory.ref === second.cpuState.resource
    ),
    false
  );
});
