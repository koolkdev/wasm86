import {
  deepStrictEqual,
  strictEqual
} from "node:assert";
import { test } from "node:test";

import {
  sourceCellForRegisterAlias
} from "#ir/block/source-cells.js";
import { registerAlias } from "#x86/registers.js";
import {
  addRegisterWait,
  createRegisterWaits,
  registerWaitsForBarrier,
  registerWaitsOverlappingWrite,
  removeRegisterWait,
  type RegisterWaitEdge
} from "#ir/block/value-plan/register-waits.js";

test("register waits return only edges overlapped by a narrow low-byte write", () => {
  const waits = createRegisterWaits<TestEdge>();
  const al = edge("al");
  const ah = edge("ah");

  addRegisterWait(waits, al);
  addRegisterWait(waits, ah);

  deepStrictEqual(registerWaitsOverlappingWrite(waits, source("al")), [al]);
});

test("register waits return only edges overlapped by a narrow high-byte write", () => {
  const waits = createRegisterWaits<TestEdge>();
  const al = edge("al");
  const ah = edge("ah");

  addRegisterWait(waits, al);
  addRegisterWait(waits, ah);

  deepStrictEqual(registerWaitsOverlappingWrite(waits, source("ah")), [ah]);
});

test("register waits dedupe wider overlaps and barriers", () => {
  const waits = createRegisterWaits<TestEdge>();
  const eax = edge("eax");
  const ax = edge("ax");

  addRegisterWait(waits, eax);
  addRegisterWait(waits, ax);

  deepStrictEqual(registerWaitsOverlappingWrite(waits, source("ax")), [eax, ax]);
  deepStrictEqual(registerWaitsForBarrier(waits), [eax, ax]);
});

test("register wait removal removes all lane memberships", () => {
  const waits = createRegisterWaits<TestEdge>();
  const eax = edge("eax");

  addRegisterWait(waits, eax);
  removeRegisterWait(waits, eax);

  strictEqual(registerWaitsForBarrier(waits).length, 0);
  strictEqual(registerWaitsOverlappingWrite(waits, source("al")).length, 0);
  strictEqual(registerWaitsOverlappingWrite(waits, source("ah")).length, 0);
});

type TestEdge = RegisterWaitEdge & Readonly<{
  id: string;
}>;

function edge(reg: Parameters<typeof registerAlias>[0]): TestEdge {
  return Object.freeze({
    id: reg,
    source: source(reg)
  });
}

function source(reg: Parameters<typeof registerAlias>[0]): TestEdge["source"] {
  const cell = sourceCellForRegisterAlias(registerAlias(reg));

  if (cell.kind !== "reg") {
    throw new Error("expected register source cell");
  }

  return cell;
}
