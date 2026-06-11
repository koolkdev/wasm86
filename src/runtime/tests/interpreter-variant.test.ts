import { strictEqual } from "node:assert";
import { test } from "node:test";

import { StopReason } from "#x86/execution/run-result.js";
import { RuntimeMode } from "#runtime/execution/mode.js";
import { RuntimeInstance } from "#runtime/runtime-instance.js";

// The engine can select the action interpreter variant; the static module
// stays the default until the action variant covers every family.

const startAddress = 0x1000;

test("runtime instance runs the action interpreter variant", () => {
  const runtime = new RuntimeInstance({
    program: {
      baseAddress: startAddress,
      bytes: [
        0xb8, 0x05, 0x00, 0x00, 0x00, // mov eax, 5
        0x05, 0x03, 0x00, 0x00, 0x00, // add eax, 3
        0xf4                          // outside the wired families
      ]
    },
    state: { eip: startAddress },
    mode: RuntimeMode.INTERPRETER,
    interpreterVariant: "action"
  });
  const result = runtime.run();

  strictEqual(result.stopReason, StopReason.UNSUPPORTED);
  strictEqual(result.finalEip, startAddress + 10);
  strictEqual(result.instructionCount, 2);
  strictEqual(runtime.memories.state.read("eax"), 8);
  strictEqual(runtime.memories.state.readFlagByte("ZF"), 0);
  strictEqual(runtime.memories.state.stopReason, StopReason.UNSUPPORTED);
});
