import { strictEqual } from "node:assert";
import { test } from "node:test";

import { startAddress } from "#test/support/addresses.js";
import { createWasmCpuStateSnapshot } from "#test/support/cpu-state.js";
import {
  assertSingleInstructionExit,
  instantiateInterpreter,
  readInterpreterState,
  writeInterpreterState,
  writeGuestBytes
} from "./harness.js";

test("interpreter binds MOV SIB index, scale, and disp32 at runtime", async () => {
  const interpreter = await instantiateInterpreter();
  const initialState = createWasmCpuStateSnapshot({
    ecx: 2,
    eip: startAddress,
    instructionCount: 7
  });

  writeInterpreterState(interpreter.stateView, initialState);
  writeGuestBytes(
    interpreter.guestView,
    startAddress,
    [0x8b, 0x04, 0x8d, 0x20, 0x00, 0x00, 0x00]
  );
  interpreter.guestView.setUint32(0x28, 0xfeed_beef, true);

  const exit = interpreter.runFor(1);
  const state = readInterpreterState(interpreter.stateView);

  assertSingleInstructionExit(exit);
  strictEqual(state.eax, 0xfeed_beef);
  strictEqual(state.ecx, initialState.ecx);
});
