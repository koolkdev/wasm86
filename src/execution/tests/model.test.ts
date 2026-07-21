import { notStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { wasmPagesForByteLength } from "#compiler/program/pages.js";
import { memoryImportFor } from "#compiler/program/resources.js";
import { createExecutionModel } from "#execution/model.js";

test("execution model composes owner-provided definitions", () => {
  const model = createExecutionModel();

  strictEqual(
    memoryImportFor(model.resources, model.cpuState.resource),
    model.cpuState.memoryImport
  );
  strictEqual(
    memoryImportFor(model.resources, model.guestMemory.resource),
    model.guestMemory.memoryImport
  );
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
  throws(
    () => memoryImportFor(first.resources, second.cpuState.resource),
    /unknown program resource cpu.state/
  );
});
