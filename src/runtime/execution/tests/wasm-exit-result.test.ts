import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { pageFault } from "#x86/exceptions.js";
import { HostExit } from "#wasm/exit.js";
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

test("wasm segment-load exits pass through to run results", () => {
  const memories = createWasmHostMemories();
  const result = runResultFromWasmExit(memories.cpuState, {
    family: "host",
    reason: HostExit.SEGMENT_LOAD,
    payload: 0x3_1234
  });

  deepStrictEqual(result.stop, {
    kind: "segmentLoad",
    segment: "ds",
    selector: 0x1234
  });
});
