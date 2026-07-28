import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeBytes, startAddress } from "./byte-reader-fixture.js";

test("string instructions expose their architectural source and destination addresses", () => {
  const result = decodeBytes([0xa5]);

  strictEqual(result.kind, "instruction");
  if (result.kind !== "instruction") {
    return;
  }

  strictEqual(result.instruction.spec.id, "movs.m32_m32");
  strictEqual(result.instruction.spec.syntax, "movs");
  deepStrictEqual(result.instruction.operands, [
    {
      kind: "mem",
      accessWidth: 32,
      segment: "ds",
      base: "esi",
      index: undefined,
      scale: 1,
      disp: 0
    },
    {
      kind: "mem",
      accessWidth: 32,
      segment: "es",
      base: "edi",
      index: undefined,
      scale: 1,
      disp: 0
    }
  ]);
});

test("repeat and operand-size prefixes compose in either order", () => {
  const repeatFirstResult = decodeBytes([0xf3, 0x66, 0xa5]);
  const operandSizeFirstResult = decodeBytes([0x66, 0xf3, 0xa5]);

  strictEqual(repeatFirstResult.kind, "instruction");
  strictEqual(operandSizeFirstResult.kind, "instruction");
  if (repeatFirstResult.kind !== "instruction" || operandSizeFirstResult.kind !== "instruction") {
    return;
  }

  for (const decoded of [repeatFirstResult.instruction, operandSizeFirstResult.instruction]) {
    strictEqual(decoded.spec.id, "movs.rep_m16_m16");
    strictEqual(decoded.spec.syntax, "rep movs");
    strictEqual(decoded.operands[0]?.kind, "mem");
    strictEqual(decoded.operands[1]?.kind, "mem");

    if (decoded.operands[0]?.kind === "mem" && decoded.operands[1]?.kind === "mem") {
      strictEqual(decoded.operands[0].accessWidth, 16);
      strictEqual(decoded.operands[1].accessWidth, 16);
    }
  }
});

test("repeat-prefix dispatch distinguishes equal and not-equal string comparisons", () => {
  const equalResult = decodeBytes([0xf3, 0xa7]);
  const notEqualResult = decodeBytes([0xf2, 0xa7]);
  const lastPrefixWinsResult = decodeBytes([0xf2, 0xf3, 0xa5]);

  strictEqual(equalResult.kind, "instruction");
  strictEqual(notEqualResult.kind, "instruction");
  strictEqual(lastPrefixWinsResult.kind, "instruction");
  if (
    equalResult.kind !== "instruction" ||
    notEqualResult.kind !== "instruction" ||
    lastPrefixWinsResult.kind !== "instruction"
  ) {
    return;
  }

  const equal = equalResult.instruction;
  const notEqual = notEqualResult.instruction;
  const lastPrefixWins = lastPrefixWinsResult.instruction;

  strictEqual(equal.spec.id, "cmps.repe_m32_m32");
  strictEqual(equal.spec.syntax, "repe cmps");
  strictEqual(notEqual.spec.id, "cmps.repne_m32_m32");
  strictEqual(notEqual.spec.syntax, "repne cmps");
  strictEqual(lastPrefixWins.spec.id, "movs.rep_m32_m32");
});

test("segment overrides affect only overridable string operands", () => {
  const movsResult = decodeBytes([0x64, 0xa4]);
  const stosResult = decodeBytes([0x65, 0xaa]);

  strictEqual(movsResult.kind, "instruction");
  strictEqual(stosResult.kind, "instruction");
  if (movsResult.kind !== "instruction" || stosResult.kind !== "instruction") {
    return;
  }

  deepStrictEqual(movsResult.instruction.operands, [
    {
      kind: "mem",
      accessWidth: 8,
      segment: "fs",
      base: "esi",
      index: undefined,
      scale: 1,
      disp: 0
    },
    {
      kind: "mem",
      accessWidth: 8,
      segment: "es",
      base: "edi",
      index: undefined,
      scale: 1,
      disp: 0
    }
  ]);
  deepStrictEqual(stosResult.instruction.operands, [
    {
      kind: "mem",
      accessWidth: 8,
      segment: "es",
      base: "edi",
      index: undefined,
      scale: 1,
      disp: 0
    }
  ]);
});

test("unsupported repeat-prefix combinations report invalid opcode after scanning", () => {
  for (const values of [
    [0xf2, 0xa4],
    [0xf3, 0x90]
  ]) {
    const decoded = decodeBytes(values);

    strictEqual(decoded.kind, "cpuException");
    if (decoded.kind !== "cpuException") {
      continue;
    }
    deepStrictEqual(decoded.exception, { kind: "UD" });
    strictEqual(decoded.instructionStart, startAddress);
    deepStrictEqual(decoded.raw, values);
  }
});
