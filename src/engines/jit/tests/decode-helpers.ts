import { ok } from "node:assert";

import { writeBackingBytes } from "#memory/bytes.js";
import { guestMemoryMinimumPages } from "#memory/constants.js";

export function jitMemoryWithBytes(
  values: readonly number[],
  baseAddress = 0
): WebAssembly.Memory {
  const memory = new WebAssembly.Memory({ initial: guestMemoryMinimumPages });
  const firstFailingAddress = writeBackingBytes(memory, baseAddress, values);

  ok(
    firstFailingAddress === undefined,
    `JIT fixture bytes exceed guest memory at 0x${firstFailingAddress?.toString(16)}`
  );
  return memory;
}
