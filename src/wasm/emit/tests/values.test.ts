import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { eipChannel, flagChannel, gprChannel, lazyFlagsAChannel, lazyFlagsKindChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import { fitsUnsigned, ValueTable } from "#ir/values.js";
import { analyzeBlockValues } from "#wasm/emit/values.js";
import { memoryCheck, memoryRead, memoryWrite, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

function analyze(
  values: ValueTable,
  actions: readonly Action[],
  exportedOutputs: readonly number[] = []
) {
  return analyzeBlockValues(
    {
      body: { actions },
      values
    },
    exportedOutputs
  );
}

test("action operand edges count at their action index", () => {
  const values = new ValueTable();
  const readOutput = values.addActionOutput();
  const address = values.const(0x1000);
  const memoryOutput = values.addActionOutput();
  const stored = values.const(1);
  const guarded = values.const(0x2000);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const condition = values.const(0);
  const payload = values.const(7);
  const analysis = analyze(
    values,
    [
      stateRead(readOutput, gprChannel("eax")),
      memoryRead(memoryOutput, address, 32),
      memoryWrite(address, stored, 32),
      memoryCheck(fault, guarded, 4, "read"),
      {
        kind: "if",
        condition: fault,
        thenBody: { actions: [{ kind: "finish", finish: { kind: "exit", reason: "memoryReadFault" } }] }
      },
      {
        kind: "if",
        condition,
        thenBody: { actions: [{ kind: "finish", finish: { kind: "exit", reason: "hostTrap" } }] },
        elseBody: { actions: [{ kind: "finish", finish: { kind: "exit", reason: "hostTrap" } }] }
      },
      { kind: "finish", finish: { kind: "exit", reason: "hostTrap", payload } }
    ]
  );

  // The dead load contributes nothing — only the store consumes the address.
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.lastUse(address), 2);
  strictEqual(analysis.useCount(stored), 1);
  strictEqual(analysis.lastUse(stored), 2);
  strictEqual(analysis.useCount(guarded), 1);
  strictEqual(analysis.lastUse(guarded), 3);
  strictEqual(analysis.useCount(fault), 1);
  strictEqual(analysis.lastUse(fault), 4);
  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.lastUse(condition), 5);
  strictEqual(analysis.useCount(payload), 1);
  strictEqual(analysis.lastUse(payload), 6);
  strictEqual(analysis.useCount(readOutput), 0);
  strictEqual(analysis.lastUse(readOutput), undefined);
});

test("a live load consumes its address at the load's index", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    memoryRead(loaded, address, 32),
    stateWrite(gprChannel("eax"), loaded)
  ]);

  strictEqual(analysis.useCount(loaded), 1);
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.lastUse(address), 0);
});

test("a chain of dead loads stays wholly uncounted", () => {
  const values = new ValueTable();
  const base = values.const(0x2000);
  const pointer = values.addActionOutput();
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    memoryRead(pointer, base, 32),
    memoryRead(loaded, pointer, 32)
  ]);

  // The second load is dead, so it never consumes the first load's output,
  // which dies in turn and never consumes the base address.
  strictEqual(analysis.useCount(loaded), 0);
  strictEqual(analysis.useCount(pointer), 0);
  strictEqual(analysis.useCount(base), 0);
});

test("fault body operands count at their if action index", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const address = values.const(0x2000);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const analysis = analyze(
    values,
    [
      stateRead(read, gprChannel("ebx")),
      memoryCheck(fault, address, 4, "write"),
      {
        kind: "if",
        condition: fault,
        thenBody: {
          actions: [
            stateWrite(gprChannel("eax"), read),
            { kind: "finish", finish: { kind: "exit", reason: "memoryWriteFault", payload: address } }
          ]
        }
      }
    ]
  );

  // The nested body branches off at the if, so its uses land there: the read is
  // consumed once at index 2; the address by the check and the payload.
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.lastUse(read), 2);
  strictEqual(analysis.useCount(address), 2);
  strictEqual(analysis.lastUse(address), 2);
  strictEqual(analysis.useCount(fault), 1);
  strictEqual(analysis.lastUse(fault), 2);
});

test("branch edge values count once per edge, at the branch's entry index", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const condition = values.const(1);
  const target = values.const(0x2000);
  const fallthrough = values.const(0x2004);
  const analysis = analyze(
    values,
    [
      stateRead(read, gprChannel("ebx")),
      {
        kind: "if",
        condition,
        thenBody: {
          actions: [
            stateWrite(gprChannel("eax"), read),
            stateWrite(eipChannel, target),
            { kind: "finish", finish: { kind: "dispatch", targetEip: target } }
          ]
        },
        elseBody: {
          actions: [
            stateWrite(gprChannel("eax"), read),
            stateWrite(eipChannel, fallthrough),
            { kind: "finish", finish: { kind: "dispatch", targetEip: fallthrough } }
          ]
        }
      }
    ]
  );

  strictEqual(analysis.useCount(read), 2);
  strictEqual(analysis.lastUse(read), 1);
  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.useCount(target), 1);
  strictEqual(analysis.useCount(fallthrough), 1);
});

test("an edge use past an overlapping store pins the read", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const address = values.const(0x2000);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const analysis = analyze(
    values,
    [
      stateRead(read, gprChannel("eax")),
      stateWrite(gprChannel("eax"), five),
      memoryCheck(fault, address, 4, "write"),
      {
        kind: "if",
        condition: fault,
        thenBody: {
          actions: [
            stateWrite(gprChannel("ebx"), read),
            { kind: "finish", finish: { kind: "exit", reason: "memoryWriteFault", payload: address } }
          ]
        }
      }
    ]
  );

  // The fault body consumes the read, but the entry already flushed a newer
  // eax before the check-if: reloading in the body would observe it, so the
  // read pins at its action point.
  strictEqual(analysis.isPinned(read), true);
});

test("a lazy kind byte read crossing a lazy-kind-byte write pins, but lazy operands do not", () => {
  const values = new ValueTable();
  const kindByte = values.addActionOutput();
  const lazyA = values.addActionOutput();
  const reset = values.const(0);
  const analysis = analyze(values, [
    stateRead(kindByte, lazyFlagsKindChannel),
    stateRead(lazyA, lazyFlagsAChannel),
    stateWrite(lazyFlagsKindChannel, reset),
    stateWrite(gprChannel("eax"), kindByte),
    stateWrite(gprChannel("ebx"), lazyA)
  ]);

  strictEqual(analysis.isPinned(kindByte), true);
  strictEqual(analysis.isPinned(lazyA), false);
});

test("an edge value reloading a channel the edge flushes pins the read", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const address = values.const(0x2000);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const analysis = analyze(
    values,
    [
      stateRead(read, gprChannel("ebx")),
      memoryCheck(fault, address, 4, "write"),
      {
        kind: "if",
        condition: fault,
        thenBody: {
          actions: [
            stateWrite(gprChannel("eax"), read),
            stateWrite(gprChannel("ebx"), five),
            { kind: "finish", finish: { kind: "exit", reason: "memoryWriteFault", payload: address } }
          ]
        }
      }
    ]
  );

  // The edge body restores ebx itself, so reloading the ebx read inside the
  // edge would observe that store had it been emitted first: the read pins,
  // leaving the edge free to order its flushes and exit.
  strictEqual(analysis.isPinned(read), true);
});

test("compound children count once per parent, at the parent's first use", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), sum),
    stateWrite(gprChannel("ecx"), sum)
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
  const values = new ValueTable();
  const read = values.addActionOutput();
  const doubled = values.binary("add", read, read);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("eax"), doubled)
  ]);

  strictEqual(analysis.useCount(doubled), 1);
  strictEqual(analysis.useCount(read), 2);
  strictEqual(analysis.lastUse(read), 1);
});

test("compounds nothing references contribute no uses", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const five = values.const(5);
  const sum = values.binary("add", read, five);
  const dead = values.binary("xor", read, five);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), sum)
  ]);

  strictEqual(analysis.useCount(dead), 0);
  strictEqual(analysis.lastUse(dead), undefined);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(five), 1);
});

test("last use flows through nested compounds from the outermost first use", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const one = values.const(1);
  const two = values.const(2);
  const inner = values.binary("add", read, one);
  const outer = values.binary("add", inner, two);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), outer),
    stateWrite(gprChannel("ecx"), outer)
  ]);

  strictEqual(analysis.lastUse(outer), 2);
  strictEqual(analysis.useCount(inner), 1);
  strictEqual(analysis.lastUse(inner), 1);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.lastUse(read), 1);
});

test("the xchg shape pins only the read whose use crosses the store", () => {
  const values = new ValueTable();
  const eax = values.addActionOutput();
  const ebx = values.addActionOutput();
  const analysis = analyze(values, [
    stateRead(eax, gprChannel("eax")),
    stateRead(ebx, gprChannel("ebx")),
    stateWrite(gprChannel("ebx"), eax),
    stateWrite(gprChannel("eax"), ebx)
  ]);

  // ebx is read before the ebx store and consumed after it: pinned. eax's
  // last use is the ebx store itself, before any eax store: load at use.
  strictEqual(analysis.isPinned(ebx), true);
  strictEqual(analysis.isPinned(eax), false);
});

test("a dynamic store pins a GPR read used later, never a flag read", () => {
  const values = new ValueTable();
  const gprRead = values.addActionOutput();
  const flagRead = values.addActionOutput();
  const index = values.external(0);
  const stored = values.const(5);
  const analysis = analyze(values, [
    stateRead(gprRead, gprChannel("eax")),
    stateRead(flagRead, flagChannel("ZF")),
    stateWrite({ kind: "gprDynamic", index, byteLength: 4 }, stored),
    stateWrite(gprChannel("ebx"), gprRead),
    stateWrite(gprChannel("ecx"), flagRead)
  ]);

  // The dynamic store may hit any GPR word, so the eax read pins; flag
  // bytes never alias dynamic slots.
  strictEqual(analysis.isPinned(gprRead), true);
  strictEqual(analysis.isPinned(flagRead), false);
});

test("a dynamic slot consumes its index once per access", () => {
  const values = new ValueTable();
  const index = values.external(0);
  const wordRead = values.addActionOutput();
  const stored = values.const(5);
  const analysis = analyze(values, [
    stateRead(wordRead, { kind: "gprDynamic", index, byteLength: 4 }),
    stateWrite(gprChannel("eax"), wordRead),
    stateWrite({ kind: "gprDynamic", index, byteLength: 1 }, stored)
  ]);

  // One use each for the word read and the byte store — the byte lowering's
  // repeated observation is a borrow, not a second counted use.
  strictEqual(analysis.useCount(index), 2);
  strictEqual(analysis.lastUse(index), 2);
});

test("a dead dynamic read never consumes its computed index", () => {
  const values = new ValueTable();
  const index = values.binary("and", values.external(0), values.const(7));
  const dead = values.addActionOutput();
  const analysis = analyze(values, [
    stateRead(dead, { kind: "gprDynamic", index, byteLength: 4 })
  ]);

  strictEqual(analysis.useCount(index), 0);
  strictEqual(analysis.lastUse(index), undefined);
});

test("an overlapping partial-channel store pins a wider read used later", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const low = values.const(0x1234);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ax"), low),
    stateWrite(gprChannel("ebx"), read)
  ]);

  strictEqual(analysis.isPinned(read), true);
});

test("a store at the value's final use does not pin it", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("eax"), sum)
  ]);

  // The operand is pushed before the store executes.
  strictEqual(analysis.isPinned(read), false);
});

test("a dead read counts zero, has no last use, and never pins", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const seven = values.const(7);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("eax"), seven)
  ]);

  strictEqual(analysis.useCount(read), 0);
  strictEqual(analysis.lastUse(read), undefined);
  strictEqual(analysis.isPinned(read), false);
});

test("analysis rejects unknown value ids", () => {
  const values = new ValueTable();
  const analysis = analyze(values, []);

  throws(() => analysis.useCount(0), /unknown value id 0/);
  throws(() => analysis.lastUse(0), /unknown value id 0/);
  throws(() => analysis.isPinned(0), /unknown value id 0/);
});

test("a producer whose operand follows its output fails loudly", () => {
  const values = new ValueTable();
  const loaded = values.addActionOutput();
  const address = values.const(0x2000);

  throws(
    () =>
      analyze(values, [
        memoryRead(loaded, address, 32)
      ]),
    /created after its output/
  );
});

test("a nested body producer whose operand follows its output fails loudly", () => {
  const values = new ValueTable();
  const loaded = values.addActionOutput();
  const address = values.const(0x2000);
  const condition = values.const(1);

  throws(
    () =>
      analyze(values, [
        {
          kind: "if",
          condition,
          thenBody: {
            actions: [
              memoryRead(loaded, address, 32),
              stateWrite(gprChannel("eax"), loaded),
              { kind: "finish", finish: { kind: "exit", reason: "memoryReadFault" } }
            ]
          }
        }
      ]),
    /created after its output/
  );
});

test("an exported output counts as a use at the action body boundary", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const analysis = analyze(
    values,
    [
      stateRead(read, gprChannel("eax"))
    ],
    [read]
  );

  // Otherwise dead, the read stays live for the embedding alone.
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.lastUse(read), 1);
  strictEqual(analysis.isPinned(read), false);
});

test("an exported read crossing an overlapping store pins", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const seven = values.const(7);
  const analysis = analyze(
    values,
    [
      stateRead(read, gprChannel("eax")),
      stateWrite(gprChannel("eax"), seven)
    ],
    [read]
  );

  // The export materializes after the store executed, so a load at the body
  // boundary would observe the new eax: the read pins.
  strictEqual(analysis.isPinned(read), true);
});
