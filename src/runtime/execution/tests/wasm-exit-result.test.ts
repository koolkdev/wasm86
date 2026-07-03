import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { pageFault } from "#x86/exceptions.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { runResultFromWasmExit } from "#runtime/execution/wasm-exit-result.js";

test("wasm CPU exception exits pass through to run results", () => {
  const memories = createWasmHostMemories();
  const exception = pageFault(0x1234, 0);
  const result = runResultFromWasmExit(memories.cpuState, {
    family: "cpuException",
    exception
  });

  deepStrictEqual(result.stop, {
    kind: "cpuException",
    exception
  });
});
