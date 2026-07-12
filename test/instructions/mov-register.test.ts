import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { CompletionExit } from "#wasm/exit.js";
import { startAddress } from "#test/support/addresses.js";
import { runCompiledInstructions } from "#test/harness/compiled-instruction.js";

test("compiled MOV copies one register to another", async () => {
  const result = await runCompiledInstructions({
    bytes: [0x89, 0xd8], // mov eax, ebx
    initialState: {
      eax: 0x1111_1111,
      ebx: 0x8765_4321,
      eip: startAddress,
      instructionCount: 7,
      CF: 1
    }
  });

  deepStrictEqual(result.completion, {
    family: "completion",
    reason: CompletionExit.LINK_STUB,
    payload: startAddress + 2
  });
  strictEqual(result.state.eax, 0x8765_4321);
  strictEqual(result.state.ebx, 0x8765_4321);
  strictEqual(result.state.CF, 1);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 8);
});
