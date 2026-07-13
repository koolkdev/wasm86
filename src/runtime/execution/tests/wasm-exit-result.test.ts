import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { pageFault } from "#core/exceptions.js";
import { HostExit } from "#wasm/exit.js";
import { createWasmHostMemories } from "#wasm/host/memories.js";
import { runResultFromWasmExit } from "#runtime/execution/wasm-exit-result.js";

test("legacy Runtime passes through Wasm CPU exception exits", () => {
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

test("legacy Runtime converts segment-load exits", () => {
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
