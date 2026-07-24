import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { decodeBytes } from "./byte-reader-fixture.js";

test("memory operands select DS or SS from their encoded base", () => {
  const ebxResult = decodeBytes([0x8b, 0x03]);
  const ebpResult = decodeBytes([0x8b, 0x45, 0x00]);
  const espThroughSibResult = decodeBytes([0x8b, 0x04, 0x24]);

  strictEqual(ebxResult.kind, "instruction");
  strictEqual(ebpResult.kind, "instruction");
  strictEqual(espThroughSibResult.kind, "instruction");
  if (
    ebxResult.kind !== "instruction" ||
    ebpResult.kind !== "instruction" ||
    espThroughSibResult.kind !== "instruction"
  ) {
    return;
  }

  const ebx = ebxResult.instruction;
  const ebp = ebpResult.instruction;
  const espThroughSib = espThroughSibResult.instruction;

  deepStrictEqual(ebx.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ds",
    base: "ebx",
    index: undefined,
    scale: 1,
    disp: 0
  });
  deepStrictEqual(ebp.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ss",
    base: "ebp",
    index: undefined,
    scale: 1,
    disp: 0
  });
  deepStrictEqual(espThroughSib.operands[1], {
    kind: "mem",
    accessWidth: 32,
    segment: "ss",
    base: "esp",
    index: undefined,
    scale: 1,
    disp: 0
  });
});

test("segment overrides replace the default and compose with operand-size prefixes", () => {
  const overriddenDefaultResult = decodeBytes([
    0x64, 0x8b, 0x45, 0x00
  ]);
  const operandSizeFirstResult = decodeBytes([
    0x66, 0x65, 0x8b, 0x03
  ]);

  strictEqual(overriddenDefaultResult.kind, "instruction");
  strictEqual(operandSizeFirstResult.kind, "instruction");
  if (
    overriddenDefaultResult.kind !== "instruction" ||
    operandSizeFirstResult.kind !== "instruction"
  ) {
    return;
  }

  const overriddenDefault = overriddenDefaultResult.instruction;
  const operandSizeFirst = operandSizeFirstResult.instruction;

  strictEqual(overriddenDefault.operands[1]?.kind, "mem");
  strictEqual(operandSizeFirst.operands[1]?.kind, "mem");

  if (
    overriddenDefault.operands[1]?.kind === "mem" &&
    operandSizeFirst.operands[1]?.kind === "mem"
  ) {
    strictEqual(overriddenDefault.operands[1].segment, "fs");
    strictEqual(operandSizeFirst.operands[1].segment, "gs");
    strictEqual(operandSizeFirst.operands[1].accessWidth, 16);
  }
});

test("the last segment override wins and also applies to moffs", () => {
  const repeatedResult = decodeBytes([0x64, 0x65, 0x8b, 0x03]);
  const moffsResult = decodeBytes([
    0x64, 0xa1, 0x78, 0x56, 0x34, 0x12
  ]);

  strictEqual(repeatedResult.kind, "instruction");
  strictEqual(moffsResult.kind, "instruction");
  if (
    repeatedResult.kind !== "instruction" ||
    moffsResult.kind !== "instruction"
  ) {
    return;
  }

  const repeated = repeatedResult.instruction;
  const moffs = moffsResult.instruction;

  strictEqual(repeated.operands[1]?.kind, "mem");
  strictEqual(moffs.operands[1]?.kind, "mem");

  if (
    repeated.operands[1]?.kind === "mem" &&
    moffs.operands[1]?.kind === "mem"
  ) {
    strictEqual(repeated.operands[1].segment, "gs");
    deepStrictEqual(moffs.operands[1], {
      kind: "mem",
      accessWidth: 32,
      segment: "fs",
      base: undefined,
      index: undefined,
      scale: 1,
      disp: 0x1234_5678
    });
  }
});
