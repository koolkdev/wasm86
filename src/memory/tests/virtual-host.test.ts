import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import { writeBackingBytes } from "#memory/bytes.js";
import { createMemoryDefinition } from "#memory/access.js";
import { pageTableEntries } from "#memory/virtual/layout.js";

test("Virtual binding clears and identity-maps the complete live RAM backing", () => {
  const definition = createMemoryDefinition();
  const machineMemoryDefinition = definition.machineMemory;
  const ram = new WebAssembly.Memory({
    initial: definition.physical.ramImport.limits.minPages
  });
  const machine = new WebAssembly.Memory({
    initial: machineMemoryDefinition.memoryImport.limits.minPages
  });
  const entries = machineMemoryDefinition.layout.array(
    pageTableEntries
  );
  const tableBytes = new Uint8Array(
    machine.buffer,
    entries.offset,
    entries.stride * entries.count
  );

  tableBytes.fill(0xff);
  const bound = definition.bindHost({ ram, machine });

  bound.initializeIdentity();
  const view = new DataView(machine.buffer);
  const mappedPageCount = ram.buffer.byteLength / 0x1000;
  let mismatch:
    | Readonly<{ index: number; actual: number; expected: number }>
    | undefined;

  for (let index = 0; index < entries.count; index += 1) {
    const actual = view.getUint32(
      entries.offset + index * entries.stride,
      true
    );
    const expected = index < mappedPageCount
      ? index * 0x1000 + 0x3
      : 0;

    if (actual !== expected) {
      mismatch = { index, actual, expected };
      break;
    }
  }

  strictEqual(mismatch, undefined);
});

test("Virtual binding reads mapped RAM without mapping later growth", () => {
  const definition = createMemoryDefinition();
  const machineMemoryDefinition = definition.machineMemory;
  const ram = new WebAssembly.Memory({
    initial: definition.physical.ramImport.limits.minPages
  });
  const machine = new WebAssembly.Memory({
    initial: machineMemoryDefinition.memoryImport.limits.minPages
  });
  const bound = definition.bindHost({ ram, machine });
  const previousByteLength = ram.buffer.byteLength;
  const finalMappedAddress = previousByteLength - 1;

  bound.initializeIdentity();
  writeBackingBytes(ram, finalMappedAddress, [0xa5]);
  deepStrictEqual(
    bound.reader.readByte(finalMappedAddress, "instructionFetch"),
    { kind: "value", value: 0xa5 }
  );

  ram.grow(1);
  writeBackingBytes(ram, previousByteLength, [0x90]);
  deepStrictEqual(
    bound.reader.readByte(previousByteLength, "instructionFetch"),
    {
      kind: "exception",
      exception: {
        kind: "PF",
        linearAddress: previousByteLength,
        errorCode: 16
      }
    }
  );
});
