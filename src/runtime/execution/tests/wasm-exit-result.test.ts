import { strictEqual } from "node:assert";
import { test } from "node:test";

import { ExitReason, type DecodedExit } from "#wasm/exit.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { StopReason } from "#x86/execution/run-result.js";
import { runResultFromWasmExit } from "#runtime/execution/wasm-exit-result.js";

test("wasm memory fault exits report byte, word, and dword fault sizes", () => {
  const cases: readonly [DecodedExit["exitReason"], number | undefined, number, "read" | "write"][] = [
    [ExitReason.MEMORY_READ_FAULT, 1, 1, "read"],
    [ExitReason.MEMORY_READ_FAULT, 2, 2, "read"],
    [ExitReason.MEMORY_READ_FAULT, undefined, 4, "read"],
    [ExitReason.MEMORY_WRITE_FAULT, 1, 1, "write"],
    [ExitReason.MEMORY_WRITE_FAULT, 2, 2, "write"],
    [ExitReason.MEMORY_WRITE_FAULT, undefined, 4, "write"]
  ];

  for (const [exitReason, detail, faultSize, faultOperation] of cases) {
    const memories = createWasmHostMemories();
    const result = runResultFromWasmExit(memories.cpuState, {
      exitReason,
      payload: 0x1234,
      ...(detail === undefined ? {} : { detail })
    });

    strictEqual(result.stopReason, StopReason.MEMORY_FAULT);
    strictEqual(result.faultAddress, 0x1234);
    strictEqual(result.faultSize, faultSize);
    strictEqual(result.faultOperation, faultOperation);
  }
});
