import {
  deepStrictEqual,
  throws
} from "node:assert";
import { test } from "node:test";

import { ValueTable } from "#compiler/ir/values/table.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import { writeBackingBytes } from "#memory/bytes.js";
import {
  flatMemoryResolution,
  flatMemoryOperand
} from "#memory/flat.js";
import {
  guestMemoryResource,
  testExecutionModel
} from "#test/support/execution-model.js";

test("flat byte reads use the flat backing boundary and requested fault intent", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const finalAddress = guestMemoryMinimumByteLength - 1;
  const reader = testExecutionModel.guestMemory.createReader(memory);

  writeBackingBytes(memory, finalAddress, [0xa5]);

  deepStrictEqual(
    reader.readByte(finalAddress, "instructionFetch"),
    { kind: "value", value: 0xa5 }
  );
  deepStrictEqual(
    reader.readByte(
      guestMemoryMinimumByteLength,
      "instructionFetch"
    ),
    {
      kind: "exception",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 16
      }
    }
  );
  deepStrictEqual(
    reader.readByte(guestMemoryMinimumByteLength, "read"),
    {
      kind: "exception",
      exception: {
        kind: "PF",
        linearAddress: guestMemoryMinimumByteLength,
        errorCode: 0
      }
    }
  );
});

test("flat byte reads validate their Memory binding", () => {
  throws(
    () => testExecutionModel.guestMemory.createReader(
      new WebAssembly.Memory({ initial: 0 })
    ),
    /guest memory is shorter than the flat address-space binding/
  );
});

test("flat resolution rejects invalid constant lengths", () => {
  const values = new ValueTable();

  throws(
    () => flatMemoryResolution(
      values,
      { start: values.const(0), byteLength: values.const(0) },
      "read"
    ),
    /flat access byte length must be an integer between 1/
  );
  throws(
    () => flatMemoryResolution(
      values,
      {
        start: values.const(0),
        byteLength: values.const(guestMemoryMinimumByteLength + 1)
      },
      "read"
    ),
    /flat access byte length must be an integer between 1/
  );
});

test("flat operands reject invalid constant subranges", () => {
  const values = new ValueTable();
  const { access } = flatMemoryResolution(
    values,
    { start: values.const(0x2000), byteLength: values.const(4) },
    "read"
  );

  throws(
    () => flatMemoryOperand(
      guestMemoryResource,
      values,
      access,
      values.const(-1),
      8
    ),
    /memory byte offset must be non-negative/
  );
  throws(
    () => flatMemoryOperand(
      guestMemoryResource,
      values,
      access,
      values.const(1),
      32
    ),
    /32-bit memory access at byte offset 1 exceeds 4-byte resolution/
  );
});
