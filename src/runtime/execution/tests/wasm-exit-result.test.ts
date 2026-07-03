import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { HostExit } from "#wasm/exit.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { runResultFromWasmExit } from "#runtime/execution/wasm-exit-result.js";

test("wasm memory fault exits report byte, word, and dword fault sizes", () => {
  const cases: readonly [HostExit, number | undefined, number, "read" | "write"][] = [
    [HostExit.MEMORY_READ_FAULT, 1, 1, "read"],
    [HostExit.MEMORY_READ_FAULT, 2, 2, "read"],
    [HostExit.MEMORY_READ_FAULT, undefined, 4, "read"],
    [HostExit.MEMORY_WRITE_FAULT, 1, 1, "write"],
    [HostExit.MEMORY_WRITE_FAULT, 2, 2, "write"],
    [HostExit.MEMORY_WRITE_FAULT, undefined, 4, "write"]
  ];

  for (const [reason, detail, faultSize, faultOperation] of cases) {
    const memories = createWasmHostMemories();
    const result = runResultFromWasmExit(memories.cpuState, {
      family: "host",
      reason,
      payload: 0x1234,
      ...(detail === undefined ? {} : { detail })
    });

    deepStrictEqual(result.stop, {
      kind: "memoryFault",
      address: 0x1234,
      size: faultSize,
      operation: faultOperation
    });
  }
});
