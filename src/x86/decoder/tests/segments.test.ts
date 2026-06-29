import { strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeBytes, ok } from "./helpers.js";
import type { IsaOperandBinding } from "#x86/decoder/types.js";

test("decodes default segments for memory operands symbolically", () => {
  strictEqual(memoryOperand([0x8b, 0x03]).segment, "ds", "base ebx defaults to ds");
  strictEqual(memoryOperand([0x8b, 0x45, 0x00]).segment, "ss", "base ebp defaults to ss");
  strictEqual(memoryOperand([0x8b, 0x04, 0x24]).segment, "ss", "base esp through SIB defaults to ss");
  strictEqual(
    memoryOperand([0x8b, 0x05, 0x00, 0x20, 0x40, 0x00]).segment,
    "ds",
    "disp32 with no base defaults to ds"
  );
  strictEqual(
    memoryOperand([0x8b, 0x04, 0x8d, 0x00, 0x20, 0x40, 0x00]).segment,
    "ds",
    "SIB with no base defaults to ds"
  );
  strictEqual(memoryOperand([0xa1, 0x78, 0x56, 0x34, 0x12]).segment, "ds", "moffs defaults to ds");
});

test("lea source operands still decode a segment even though semantics use only the offset", () => {
  strictEqual(memoryOperand([0x8d, 0x45, 0x00]).segment, "ss");
});

function memoryOperand(bytes: readonly number[]): Extract<IsaOperandBinding, { kind: "mem" }> {
  const operand = ok(decodeBytes(bytes)).operands.find((entry) => entry.kind === "mem");

  if (operand === undefined || operand.kind !== "mem") {
    throw new Error("expected a memory operand");
  }

  return operand;
}
