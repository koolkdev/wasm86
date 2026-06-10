import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#ir/action/slots.js";
import type { Action, EdgeRegion } from "#ir/action/types.js";
import { createValueTable, type ValueTable } from "#ir/action/values.js";
import { analyzeBlockValues } from "#wasm/emit/action/values.js";

function analyze(
  values: ValueTable,
  actions: readonly Action[],
  edges: readonly EdgeRegion[] = []
) {
  return analyzeBlockValues({
    entry: 0,
    regions: [{ id: 0, kind: "entry", actions }, ...edges],
    values
  });
}

test("action operand edges count at their action index", () => {
  const values = createValueTable();
  const readOutput = values.addActionOutput();
  const address = values.internConst(0x1000);
  const memoryOutput = values.addActionOutput();
  const stored = values.internConst(1);
  const guarded = values.internConst(0x2000);
  const condition = values.internConst(0);
  const payload = values.internConst(7);
  const analysis = analyze(
    values,
    [
      { kind: "readState", output: readOutput, slot: gprChannel("eax") },
      { kind: "readMemory", output: memoryOutput, address, width: 32 },
      { kind: "writeMemory", address, value: stored, width: 32 },
      { kind: "guardMemory", address: guarded, byteLength: 4, access: "read", faultEdge: 1 },
      { kind: "branch", condition, taken: 1, notTaken: 2 },
      { kind: "exit", reason: "next", payload }
    ],
    [{ id: 1, kind: "edge", flushes: [], exit: { kind: "exit", reason: "memoryReadFault" } }]
  );

  // The dead load contributes nothing — only the store consumes the address.
  strictEqual(analysis.useCount(address), 1);
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

test("a live load consumes its address at the load's index", () => {
  const values = createValueTable();
  const address = values.internConst(0x2000);
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    { kind: "readMemory", output: loaded, address, width: 32 },
    { kind: "writeState", slot: gprChannel("eax"), value: loaded },
    { kind: "exit", reason: "next" }
  ]);

  strictEqual(analysis.useCount(loaded), 1);
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.lastUse(address), 0);
});

test("a chain of dead loads stays wholly uncounted", () => {
  const values = createValueTable();
  const base = values.internConst(0x2000);
  const pointer = values.addActionOutput();
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    { kind: "readMemory", output: pointer, address: base, width: 32 },
    { kind: "readMemory", output: loaded, address: pointer, width: 32 },
    { kind: "exit", reason: "next" }
  ]);

  // The second load is dead, so it never consumes the first load's output,
  // which dies in turn and never consumes the base address.
  strictEqual(analysis.useCount(loaded), 0);
  strictEqual(analysis.useCount(pointer), 0);
  strictEqual(analysis.useCount(base), 0);
});

test("fault edge operands count at their guard's entry index", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const address = values.internConst(0x2000);
  const analysis = analyze(
    values,
    [
      { kind: "readState", output: read, slot: gprChannel("ebx") },
      { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 1 },
      { kind: "exit", reason: "next" }
    ],
    [
      {
        id: 1,
        kind: "edge",
        flushes: [{ kind: "writeState", slot: gprChannel("eax"), value: read }],
        exit: { kind: "exit", reason: "memoryWriteFault", payload: address }
      }
    ]
  );

  // The edge branches off at the guard, so its uses land there: the read is
  // consumed once, at index 1; the address by the guard and the payload.
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.lastUse(read), 1);
  strictEqual(analysis.useCount(address), 2);
  strictEqual(analysis.lastUse(address), 1);
});

test("an edge use past an overlapping store pins the read", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const address = values.internConst(0x2000);
  const analysis = analyze(
    values,
    [
      { kind: "readState", output: read, slot: gprChannel("eax") },
      { kind: "writeState", slot: gprChannel("eax"), value: five },
      { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 1 },
      { kind: "exit", reason: "next" }
    ],
    [
      {
        id: 1,
        kind: "edge",
        flushes: [{ kind: "writeState", slot: gprChannel("ebx"), value: read }],
        exit: { kind: "exit", reason: "memoryWriteFault", payload: address }
      }
    ]
  );

  // The fault edge consumes the read, but the entry already flushed a newer
  // eax before the guard: reloading in the edge would observe it, so the
  // read pins at its action point.
  strictEqual(analysis.isPinned(read), true);
});

test("an edge value reloading a channel the edge flushes pins the read", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const address = values.internConst(0x2000);
  const analysis = analyze(
    values,
    [
      { kind: "readState", output: read, slot: gprChannel("ebx") },
      { kind: "guardMemory", address, byteLength: 4, access: "write", faultEdge: 1 },
      { kind: "exit", reason: "next" }
    ],
    [
      {
        id: 1,
        kind: "edge",
        flushes: [
          { kind: "writeState", slot: gprChannel("eax"), value: read },
          { kind: "writeState", slot: gprChannel("ebx"), value: five }
        ],
        exit: { kind: "exit", reason: "memoryWriteFault", payload: address }
      }
    ]
  );

  // The edge body restores ebx itself, so reloading the ebx read inside the
  // edge would observe that store had it been emitted first: the read pins,
  // leaving the edge free to order its flushes and exit.
  strictEqual(analysis.isPinned(read), true);
});

test("compound children count once per parent, at the parent's first use", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const five = values.internConst(5);
  const sum = values.internBinary("add", read, five);
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: sum },
    { kind: "writeState", slot: gprChannel("ecx"), value: sum },
    { kind: "exit", reason: "next" }
  ]);

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
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("eax"), value: doubled },
    { kind: "exit", reason: "next" }
  ]);

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
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: sum },
    { kind: "exit", reason: "next" }
  ]);

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
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ebx"), value: outer },
    { kind: "writeState", slot: gprChannel("ecx"), value: outer },
    { kind: "exit", reason: "next" }
  ]);

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
  const analysis = analyze(values, [
    { kind: "readState", output: eax, slot: gprChannel("eax") },
    { kind: "readState", output: ebx, slot: gprChannel("ebx") },
    { kind: "writeState", slot: gprChannel("ebx"), value: eax },
    { kind: "writeState", slot: gprChannel("eax"), value: ebx },
    { kind: "exit", reason: "next" }
  ]);

  // ebx is read before the ebx store and consumed after it: pinned. eax's
  // last use is the ebx store itself, before any eax store: load at use.
  strictEqual(analysis.isPinned(ebx), true);
  strictEqual(analysis.isPinned(eax), false);
});

test("an overlapping partial-channel store pins a wider read used later", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const low = values.internConst(0x1234);
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("ax"), value: low },
    { kind: "writeState", slot: gprChannel("ebx"), value: read },
    { kind: "exit", reason: "next" }
  ]);

  strictEqual(analysis.isPinned(read), true);
});

test("a store at the value's final use does not pin it", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const one = values.internConst(1);
  const sum = values.internBinary("add", read, one);
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("eax"), value: sum },
    { kind: "exit", reason: "next" }
  ]);

  // The operand is pushed before the store executes.
  strictEqual(analysis.isPinned(read), false);
});

test("a dead read counts zero, has no last use, and never pins", () => {
  const values = createValueTable();
  const read = values.addActionOutput();
  const seven = values.internConst(7);
  const analysis = analyze(values, [
    { kind: "readState", output: read, slot: gprChannel("eax") },
    { kind: "writeState", slot: gprChannel("eax"), value: seven },
    { kind: "exit", reason: "next" }
  ]);

  strictEqual(analysis.useCount(read), 0);
  strictEqual(analysis.lastUse(read), undefined);
  strictEqual(analysis.isPinned(read), false);
});

test("analysis rejects unknown value ids", () => {
  const values = createValueTable();
  const analysis = analyze(values, [{ kind: "exit", reason: "next" }]);

  throws(() => analysis.useCount(0), /unknown value id 0/);
  throws(() => analysis.lastUse(0), /unknown value id 0/);
  throws(() => analysis.isPinned(0), /unknown value id 0/);
});

test("a producer whose operand follows its output fails loudly", () => {
  const values = createValueTable();
  const loaded = values.addActionOutput();
  const address = values.internConst(0x2000);

  throws(
    () =>
      analyze(values, [
        { kind: "readMemory", output: loaded, address, width: 32 },
        { kind: "exit", reason: "next" }
      ]),
    /interned after its output/
  );
});

test("a guard targeting a missing edge region fails loudly", () => {
  const values = createValueTable();
  const address = values.internConst(0x2000);

  throws(
    () =>
      analyze(values, [
        { kind: "guardMemory", address, byteLength: 4, access: "read", faultEdge: 9 },
        { kind: "exit", reason: "next" }
      ]),
    /unknown fault edge 9/
  );
});
