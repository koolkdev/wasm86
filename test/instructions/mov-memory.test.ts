import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { PageFaultErrorCode, pageFault } from "#core/exceptions.js";
import { startAddress } from "#test/support/addresses.js";
import { runCompiledInstructions } from "#test/harness/compiled-instruction.js";
import { wasmGuestMemoryMinByteLength } from "#wasm/abi.js";
import { CompletionExit } from "#wasm/exit.js";

test("compiled MOV writes a register to memory", async () => {
  const address = 0x2000;
  const result = await runCompiledInstructions({
    bytes: [0x89, 0x18], // mov [eax], ebx
    initialState: {
      eax: address,
      ebx: 0x8765_4321,
      eip: startAddress,
      instructionCount: 3
    },
    memoryPatches: [{ address, bytes: [0, 0, 0, 0] }],
    memoryRanges: [{ address, byteLength: 4 }]
  });

  deepStrictEqual(result.completion, {
    family: "completion",
    reason: CompletionExit.LINK_STUB,
    payload: startAddress + 2
  });
  deepStrictEqual(result.memory, [{
    address,
    byteLength: 4,
    bytes: [0x21, 0x43, 0x65, 0x87]
  }]);
  strictEqual(result.state.eip, startAddress + 2);
  strictEqual(result.state.instructionCount, 4);
});

test("faulting compiled MOV preserves instruction-start state and memory", async () => {
  const faultAddress = wasmGuestMemoryMinByteLength - 2;
  const observedAddress = faultAddress - 2;
  const initialBytes = [0xaa, 0xbb, 0xcc, 0xdd];
  const result = await runCompiledInstructions({
    bytes: [0x89, 0x18], // mov [eax], ebx
    initialState: {
      eax: faultAddress,
      ebx: 0x8765_4321,
      eip: startAddress,
      instructionCount: 7,
      CF: 1
    },
    memoryPatches: [{ address: observedAddress, bytes: initialBytes }],
    memoryRanges: [{ address: observedAddress, byteLength: initialBytes.length }]
  });

  deepStrictEqual(result.completion, {
    family: "cpuException",
    exception: pageFault(faultAddress, PageFaultErrorCode.WRITE)
  });
  deepStrictEqual(result.memory, [{
    address: observedAddress,
    byteLength: initialBytes.length,
    bytes: initialBytes
  }]);
  strictEqual(result.state.eax, faultAddress);
  strictEqual(result.state.ebx, 0x8765_4321);
  strictEqual(result.state.CF, 1);
  strictEqual(result.state.eip, startAddress);
  strictEqual(result.state.instructionCount, 7);
});
