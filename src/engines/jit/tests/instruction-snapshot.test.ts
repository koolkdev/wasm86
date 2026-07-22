import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { writeBackingBytes } from "#memory/bytes.js";
import { testExecutionModel } from "#test/support/execution-model.js";
import {
  guestMemoryMinimumByteLength,
  guestMemoryMinimumPages
} from "#memory/constants.js";
import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";
import {
  snapshotInstructionBytes,
  type InstructionByteSnapshot,
  type InstructionSnapshotRequest
} from "#engines/jit/instruction-snapshot.js";

test("flat instruction snapshots copy their complete readable request", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });

  writeBackingBytes(memory, 0x1000, [0x12, 0x34, 0x56]);
  const snapshot = snapshotFromMemory(
    memory,
    { linearStart: 0x1000, byteLength: 3 }
  );

  strictEqual(snapshot.linearStart, 0x1000);
  deepStrictEqual(snapshot.readByte(0x1000), { kind: "value", value: 0x12 });
  deepStrictEqual(snapshot.readByte(0x1002), { kind: "value", value: 0x56 });
  throws(
    () => snapshot.readByte(0x1003),
    /lies outside its copied prefix and unreadable boundary/
  );
});

test("flat instruction snapshots return their maximal prefix and one boundary fault", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const linearStart = guestMemoryMinimumByteLength - 2;

  writeBackingBytes(memory, linearStart, [0xa5, 0x5a]);
  const snapshot = snapshotFromMemory(
    memory,
    { linearStart, byteLength: 8 }
  );
  const exception = pageFault(
    guestMemoryMinimumByteLength,
    PageFaultErrorCode.INSTRUCTION_FETCH
  );

  deepStrictEqual(snapshot.readByte(linearStart + 1), {
    kind: "value",
    value: 0x5a
  });
  deepStrictEqual(snapshot.readByte(guestMemoryMinimumByteLength), {
    kind: "exception",
    exception
  });
});

test("an inaccessible instruction snapshot start produces an empty snapshot", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const snapshot = snapshotFromMemory(
    memory,
    { linearStart: guestMemoryMinimumByteLength, byteLength: 15 }
  );

  deepStrictEqual(snapshot.readByte(guestMemoryMinimumByteLength), {
    kind: "exception",
    exception: pageFault(
      guestMemoryMinimumByteLength,
      PageFaultErrorCode.INSTRUCTION_FETCH
    )
  });
});

test("instruction snapshots do not observe later guest mutation", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });

  writeBackingBytes(memory, 0x1000, [0x11]);
  const snapshot = snapshotFromMemory(
    memory,
    { linearStart: 0x1000, byteLength: 1 }
  );

  writeBackingBytes(memory, 0x1000, [0x22]);
  deepStrictEqual(snapshot.readByte(0x1000), { kind: "value", value: 0x11 });
  deepStrictEqual(
    snapshotFromMemory(memory, { linearStart: 0x1000, byteLength: 1 })
      .readByte(0x1000),
    { kind: "value", value: 0x22 }
  );
});

test("flat snapshot authority keeps its boundary after backing growth", () => {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });

  memory.grow(1);
  writeBackingBytes(memory, guestMemoryMinimumByteLength, [0x90]);
  const snapshot = snapshotFromMemory(
    memory,
    { linearStart: guestMemoryMinimumByteLength, byteLength: 1 }
  );

  deepStrictEqual(snapshot.readByte(guestMemoryMinimumByteLength), {
    kind: "exception",
    exception: pageFault(
      guestMemoryMinimumByteLength,
      PageFaultErrorCode.INSTRUCTION_FETCH
    )
  });
});

function snapshotFromMemory(
  memory: WebAssembly.Memory,
  request: InstructionSnapshotRequest
): InstructionByteSnapshot {
  return snapshotInstructionBytes(
    testExecutionModel.guestMemory.createReader(memory),
    request
  );
}
