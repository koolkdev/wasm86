import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/action/slots.js";
import type { ActionRegion } from "#ir/action/types.js";
import { createValueTable } from "#ir/action/values.js";
import { analyzeRegionValues } from "#wasm/emit/action/values.js";

function entryRegion(actions: ActionRegion["actions"]): ActionRegion {
  return { id: 0, kind: "entry", actions };
}

test("action operand edges count at their action index", () => {
  const values = createValueTable();
  const readOutput = values.addActionOutput();
  const memoryOutput = values.addActionOutput();
  const address = values.internConst(0x1000);
  const stored = values.internConst(1);
  const guarded = values.internConst(0x2000);
  const condition = values.internConst(0);
  const payload = values.internConst(7);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: readOutput, slot: gprChannel("eax") },
      { kind: "readMemory", output: memoryOutput, address, width: 32 },
      { kind: "writeMemory", address, value: stored, width: 32 },
      { kind: "guardMemory", address: guarded, byteLength: 4, access: "read", faultEdge: 1 },
      { kind: "branch", condition, taken: 1, notTaken: 2 },
      { kind: "exit", reason: "next", payload }
    ]),
    values
  );

  strictEqual(analysis.useCount(address), 2);
  strictEqual(analysis.lastUse(address), 2);
  strictEqual(analysis.useCount(stored), 1);
  strictEqual(analysis.lastUse(stored), 2);
  strictEqual(analysis.useCount(guarded), 1);
  strictEqual(analysis.lastUse(guarded), 3);
  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.lastUse(condition), 4);
  strictEqual(analysis.useCount(payload), 1);
  strictEqual(analysis.lastUse(payload), 5);
  strictEqual(analysis.useCount(readOutput), 0);
  strictEqual(analysis.lastUse(readOutput), undefined);
});

test("compound children count once per parent, at the parent's first use", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "writeState", slot: gprChannel("ecx"), value: sum },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  strictEqual(analysis.useCount(sum), 2);
  strictEqual(analysis.lastUse(sum), 2);

  // sum computes once, at action 1 — its operands are not consumed again by
  // the action-2 replay.
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.lastUse(read), 1);
  strictEqual(analysis.useCount(five), 1);
  strictEqual(analysis.lastUse(five), 1);
});

test("repeated child edges within one parent count per edge", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const doubled = values.internBinary("add", read, read);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("eax"), value: doubled },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  strictEqual(analysis.useCount(doubled), 1);
  strictEqual(analysis.useCount(read), 2);
  strictEqual(analysis.lastUse(read), 1);
});

test("compounds nothing references contribute no uses", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const dead = values.internBinary("xor", read, five);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("ebx"), value: sum },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  strictEqual(analysis.useCount(dead), 0);
  strictEqual(analysis.lastUse(dead), undefined);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(five), 1);
});

test("last use flows through nested compounds from the outermost first use", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const one = values.internConst(1);
  const two = values.internConst(2);
  const inner = values.internBinary("add", read, one);
  const outer = values.internBinary("add", inner, two);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("ebx"), value: outer },
      { kind: "writeState", slot: gprChannel("ecx"), value: outer },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  strictEqual(analysis.lastUse(outer), 2);
  strictEqual(analysis.useCount(inner), 1);
  strictEqual(analysis.lastUse(inner), 1);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.lastUse(read), 1);
});

test("the xchg shape pins only the read whose use crosses the store", () => {
  const values = createValueTable();
  const eax = values.addActionOutput();
  const ebx = values.addActionOutput();
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: eax, slot: gprChannel("eax") },
      { kind: "readState", output: ebx, slot: gprChannel("ebx") },
      { kind: "writeState", slot: gprChannel("ebx"), value: eax },
      { kind: "writeState", slot: gprChannel("eax"), value: ebx },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  // ebx is read before the ebx store and consumed after it: pinned. eax's
  // last use is the ebx store itself, before any eax store: load at use.
  strictEqual(analysis.isPinned(ebx), true);
  strictEqual(analysis.isPinned(eax), false);
});

test("an overlapping partial-channel store pins a wider read used later", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const low = values.internConst(0x1234);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("ax"), value: low },
      { kind: "writeState", slot: gprChannel("ebx"), value: read },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  strictEqual(analysis.isPinned(read), true);
});

test("a store at the value's final use does not pin it", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const one = values.internConst(1);
  const sum = values.internBinary("add", read, one);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("eax"), value: sum },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  // The operand is pushed before the store executes.
  strictEqual(analysis.isPinned(read), false);
});

test("a dead read counts zero, has no last use, and never pins", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const seven = values.internConst(7);
  const analysis = analyzeRegionValues(
    entryRegion([
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("eax"), value: seven },
      { kind: "exit", reason: "next" }
    ]),
    values
  );

  strictEqual(analysis.useCount(read), 0);
  strictEqual(analysis.lastUse(read), undefined);
  strictEqual(analysis.isPinned(read), false);
});

test("analysis rejects unknown value ids", () => {
  const values = createValueTable();
  const analysis = analyzeRegionValues(entryRegion([{ kind: "exit", reason: "next" }]), values);

  throws(() => analysis.useCount(0), /unknown value id 0/);
  throws(() => analysis.lastUse(0), /unknown value id 0/);
  throws(() => analysis.isPinned(0), /unknown value id 0/);
});
