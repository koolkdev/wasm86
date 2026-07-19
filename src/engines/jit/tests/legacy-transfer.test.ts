import { deepStrictEqual, strictEqual } from "node:assert";
import { test } from "node:test";

import { encodeVariant } from "#compiler/layout/variant-codec.js";
import {
  exceptionExit,
  segmentExit,
  trapExit
} from "#core/exits.js";
import {
  divideError,
  generalProtection,
  invalidOpcode,
  pageFault
} from "#core/exceptions.js";
import { exitLayout } from "#cpu/exit.js";
import {
  budgetExit,
  missExit
} from "#engines/interpreter/exits.js";
import {
  decodeTransfer,
  encodeTransfer,
  type LegacyTransfer
} from "#engines/jit/legacy-transfer.js";

test("legacy JIT transfers round-trip through their narrowed codec", () => {
  const transfers = [
    { kind: "dynamicJump" },
    { kind: "linkStub", targetEip: 0 },
    { kind: "linkStub", targetEip: 0x8000_0000 },
    { kind: "linkStub", targetEip: 0xffff_ffff }
  ] as const satisfies readonly LegacyTransfer[];

  for (const transfer of transfers) {
    deepStrictEqual(
      decodeTransfer(encodeTransfer(transfer)),
      transfer
    );
  }
});

test("the extracted codec preserves the raw JIT wire values", () => {
  strictEqual(
    encodeTransfer({ kind: "dynamicJump" }),
    0x0101_0000_0000n
  );
  strictEqual(
    encodeTransfer({ kind: "linkStub", targetEip: 0x89ab_cdef }),
    0x0102_89ab_cdefn
  );
});

test("legacy JIT transfers are disjoint from Cpu exits", () => {
  const exits = [
    encodeVariant(
      exitLayout,
      exceptionExit(divideError<number>())
    ),
    encodeVariant(
      exitLayout,
      exceptionExit(invalidOpcode<number>())
    ),
    encodeVariant(
      exitLayout,
      exceptionExit(generalProtection(0xffff))
    ),
    encodeVariant(
      exitLayout,
      exceptionExit(pageFault(0xffff_ffff, 0xffff))
    ),
    encodeVariant(exitLayout, trapExit(0xff)),
    encodeVariant(exitLayout, segmentExit(5, 0xffff)),
    encodeVariant(exitLayout, budgetExit()),
    encodeVariant(exitLayout, missExit())
  ];

  for (const exit of exits) {
    strictEqual(decodeTransfer(exit), undefined);
  }
});
