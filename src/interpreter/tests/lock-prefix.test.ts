import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { invalidOpcode } from "#core/exceptions.js";
import { startAddress } from "#test/support/addresses.js";
import { createWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  assertInterpreterStateEquals,
  instantiateInterpreter,
  writeGuestBytes,
  writeInterpreterState
} from "./harness.js";

test("Interpreter rejects a LOCK-prefixed compare-exchange form", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    eax: 5,
    ebx: 9,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(
    interpreter.guestView,
    startAddress,
    [0xf0, 0x0f, 0xb1, 0xd8]
  );

  deepStrictEqual(interpreter.runFor(1), {
    kind: "cpuException",
    exception: invalidOpcode()
  });
  assertInterpreterStateEquals(interpreter.stateView, initialState);
});
