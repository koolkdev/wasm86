import { notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { createExecutionModel } from "#execution/model.js";

test("execution model composes owner-provided definitions", () => {
  const model = createExecutionModel();

  ok(model.resources.memoryImports.includes(model.cpuState.memoryImport));
  ok(
    model.resources.memoryImports.includes(
      model.memory.physical.ramImport
    )
  );
  ok(
    model.resources.memoryImports.includes(
      model.memory.virtualStorage.machineImport
    )
  );
  strictEqual(
    model.memory.virtualStorage.machineImport.ref,
    model.memory.virtualStorage.machineResource
  );
  strictEqual(model.cpuState.memoryImport.limits.minPages, 1);
  strictEqual(model.memory.physical.ramImport.limits.minPages, 1);
});

test("execution models use distinct symbolic resource identities", () => {
  const first = createExecutionModel();
  const second = createExecutionModel();

  notStrictEqual(first.cpuState.resource, second.cpuState.resource);
  notStrictEqual(first.cpuState.access, second.cpuState.access);
  notStrictEqual(
    first.memory.physical.ramResource,
    second.memory.physical.ramResource
  );
  notStrictEqual(
    first.memory.physical.access,
    second.memory.physical.access
  );
  notStrictEqual(
    first.memory.virtualStorage.machineResource,
    second.memory.virtualStorage.machineResource
  );
  notStrictEqual(first.memory.access, second.memory.access);
  strictEqual(
    first.resources.memoryImports.some(
      (memory) => memory.ref === second.cpuState.resource
    ),
    false
  );
});
