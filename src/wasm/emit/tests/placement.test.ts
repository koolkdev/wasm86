import { deepStrictEqual, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import { eipChannel, flagChannel, gprChannel, lazyFlagsAChannel, lazyFlagsBChannel, lazyFlagsKindChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import { fitsUnsigned, ValueTable } from "#ir/values.js";
import { analyzePlacement } from "#wasm/emit/placement.js";
import { PageFaultErrorCode, pageFault } from "#x86/exceptions.js";
import { memoryCheck, memoryRead, memoryWrite, resolveFlag, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

function analyze(
  values: ValueTable,
  actions: readonly Action[],
  exportedOutputs: readonly number[] = []
) {
  return analyzePlacement(
    {
      body: { actions },
      values
    },
    exportedOutputs
  );
}

function hostExit(payload?: number): Action {
  return {
    kind: "finish",
    finish: {
      kind: "exit",
      exit: {
        class: "host",
        reason: "hostTrap",
        ...(payload === undefined ? {} : { payload })
      }
    }
  };
}

function pageFaultExit(address: number, write = false): Action {
  return {
    kind: "finish",
    finish: {
      kind: "exit",
      exit: {
        class: "cpuException",
        exception: pageFault(address, write ? PageFaultErrorCode.WRITE : 0)
      }
    }
  };
}

test("action operands count one use per consuming action", () => {
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
        thenBody: { actions: [pageFaultExit(guarded)] }
      },
      {
        kind: "if",
        condition,
        thenBody: { actions: [hostExit()] },
        elseBody: { actions: [hostExit()] }
      },
      hostExit(payload)
    ]
  );

  // The dead load contributes nothing — only the store consumes the address.
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.useCount(stored), 1);
  strictEqual(analysis.useCount(guarded), 2);
  strictEqual(analysis.useCount(fault), 1);
  strictEqual(analysis.outputPlacement(fault).kind, "deferToUse");
  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.useCount(payload), 1);
  strictEqual(analysis.useCount(readOutput), 0);
});

test("a deferred load charges its address once however many sites consume it", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    memoryRead(loaded, address, 32),
    stateWrite(gprChannel("eax"), loaded),
    stateWrite(gprChannel("ebx"), loaded)
  ]);

  // No memory.write intervenes, so the load executes at its first use;
  // however many sites consume the output, the address charges once, there.
  strictEqual(analysis.outputPlacement(loaded).kind, "deferToUse");
  strictEqual(analysis.useCount(loaded), 2);
  strictEqual(analysis.useCount(address), 1);
});

test("a load captures across a memory.write", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const stored = values.const(1);
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    memoryRead(loaded, address, 32),
    memoryWrite(address, stored, 32),
    stateWrite(gprChannel("eax"), loaded)
  ]);

  // Deferring past the store would observe the new bytes: the load executes
  // at its action point and charges its address there.
  strictEqual(analysis.outputPlacement(loaded).kind, "captureAtProducer");
  strictEqual(analysis.useCount(address), 2);
});

test("a check defers across a memory.write", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const stored = values.const(1);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const analysis = analyze(values, [
    memoryCheck(fault, address, 4, "write"),
    memoryWrite(address, stored, 32),
    {
      kind: "if",
      condition: fault,
      thenBody: { actions: [pageFaultExit(address, true)] }
    }
  ]);

  // The check reads only the memory bounds, which no store touches: the
  // fault flag sinks into its if condition.
  strictEqual(analysis.outputPlacement(fault).kind, "deferToUse");
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

test("fault body operands count once per edge use", () => {
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
            pageFaultExit(address, true)
          ]
        }
      }
    ]
  );

  // The nested body's uses are ordinary demand: the read is consumed once,
  // the address by the check and the fault payload.
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(address), 2);
  strictEqual(analysis.useCount(fault), 1);
});

test("branch edge values count once per edge", () => {
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
  strictEqual(analysis.useCount(condition), 1);
  strictEqual(analysis.useCount(target), 1);
  strictEqual(analysis.useCount(fallthrough), 1);
});

test("dispatch target references are not demand roots", () => {
  const values = new ValueTable();
  const target = values.const(0x2000);
  const analysis = analyze(values, [
    { kind: "finish", finish: { kind: "dispatch", targetEip: target } }
  ]);

  strictEqual(analysis.useCount(target), 0);
});

test("an edge use past an overlapping store captures the read at its producer", () => {
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
            pageFaultExit(address, true)
          ]
        }
      }
    ]
  );

  // The fault body consumes the read, but the entry already flushed a newer
  // eax before the check-if: reloading in the body would observe it, so the
  // read captures at its action point.
  strictEqual(analysis.outputPlacement(read).kind, "captureAtProducer");
});

test("a lazy kind byte read crossing a lazy-kind-byte write captures, but lazy operands defer", () => {
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

  strictEqual(analysis.outputPlacement(kindByte).kind, "captureAtProducer");
  strictEqual(analysis.outputPlacement(lazyA).kind, "deferToUse");
});

test("an edge value reloading a channel the edge flushes captures the read", () => {
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
            pageFaultExit(address, true)
          ]
        }
      }
    ]
  );

  // The edge body restores ebx itself, so reloading the ebx read inside the
  // edge would observe that store had it been emitted first: the read
  // captures, leaving the edge free to order its flushes and exit.
  strictEqual(analysis.outputPlacement(read).kind, "captureAtProducer");
});

test("compound children count once per parent, not per replay", () => {
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

  // sum computes once, at its first use — its operands are not consumed
  // again by the later replay.
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(five), 1);
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
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(five), 1);
});

test("charging flows through nested compounds once", () => {
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

  strictEqual(analysis.useCount(inner), 1);
  strictEqual(analysis.useCount(read), 1);
});

test("the xchg shape captures only the read whose use crosses the store", () => {
  const values = new ValueTable();
  const eax = values.addActionOutput();
  const ebx = values.addActionOutput();
  const analysis = analyze(values, [
    stateRead(eax, gprChannel("eax")),
    stateRead(ebx, gprChannel("ebx")),
    stateWrite(gprChannel("ebx"), eax),
    stateWrite(gprChannel("eax"), ebx)
  ]);

  // ebx is read before the ebx store and consumed after it: captured. eax's
  // last use is the ebx store itself, before any eax store: load at use.
  strictEqual(analysis.outputPlacement(ebx).kind, "captureAtProducer");
  strictEqual(analysis.outputPlacement(eax).kind, "deferToUse");
});

test("a dynamic store captures a GPR read used later, never a flag read", () => {
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

  // The dynamic store may hit any GPR word, so the eax read captures; flag
  // bytes never alias dynamic slots.
  strictEqual(analysis.outputPlacement(gprRead).kind, "captureAtProducer");
  strictEqual(analysis.outputPlacement(flagRead).kind, "deferToUse");
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

  // One use each for the word read and the byte store — the byte access's
  // repeated observation is a borrow, not a second counted use. The read's
  // use precedes the dynamic store, so it defers.
  strictEqual(analysis.useCount(index), 2);
  strictEqual(analysis.outputPlacement(wordRead).kind, "deferToUse");
});

test("a dead dynamic read never consumes its computed index", () => {
  const values = new ValueTable();
  const index = values.binary("and", values.external(0), values.const(7));
  const dead = values.addActionOutput();
  const analysis = analyze(values, [
    stateRead(dead, { kind: "gprDynamic", index, byteLength: 4 })
  ]);

  strictEqual(analysis.useCount(index), 0);
  strictEqual(analysis.outputPlacement(dead).kind, "deferToUse");
});

test("a flag resolve captures across a lazy-channel write and defers otherwise", () => {
  const pinned = new ValueTable();
  const observed = pinned.addActionOutput(fitsUnsigned(1));
  const record = pinned.const(0);
  const across = analyze(pinned, [
    resolveFlag(observed, "ZF"),
    stateWrite(lazyFlagsBChannel, record),
    stateWrite(gprChannel("eax"), observed)
  ]);

  // The helper reads the lazy channels, so a lazy record between the
  // resolve and its use pins the observation point.
  strictEqual(across.outputPlacement(observed).kind, "captureAtProducer");

  const values = new ValueTable();
  const resolved = values.addActionOutput(fitsUnsigned(1));
  const five = values.const(5);
  const analysis = analyze(values, [
    resolveFlag(resolved, "ZF"),
    stateWrite(gprChannel("ebx"), five),
    stateWrite(gprChannel("eax"), resolved)
  ]);

  // GPR stores touch neither the flag byte nor the lazy channels: the pure
  // helper call sinks to its use.
  strictEqual(analysis.outputPlacement(resolved).kind, "deferToUse");
});

test("a dynamic read captures across an overlapping GPR write and defers otherwise", () => {
  const pinned = new ValueTable();
  const pinnedIndex = pinned.external(0);
  const pinnedRead = pinned.addActionOutput();
  const five = pinned.const(5);
  const across = analyze(pinned, [
    stateRead(pinnedRead, { kind: "gprDynamic", index: pinnedIndex, byteLength: 4 }),
    stateWrite(gprChannel("eax"), five),
    stateWrite(gprChannel("ebx"), pinnedRead)
  ]);

  // The dynamic slot may be any GPR word, so the eax store may overwrite
  // what the read observes.
  strictEqual(across.outputPlacement(pinnedRead).kind, "captureAtProducer");

  const values = new ValueTable();
  const index = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const analysis = analyze(values, [
    stateRead(read, { kind: "gprDynamic", index, byteLength: 4 }),
    stateWrite(flagChannel("ZF"), one),
    stateWrite(gprChannel("ebx"), read)
  ]);

  // Flag bytes never alias GPR words: the read executes once, at its use,
  // consuming its index exactly once — there.
  strictEqual(analysis.outputPlacement(read).kind, "deferToUse");
  strictEqual(analysis.useCount(index), 1);
});

test("a store past the first use leaves a multi-use read deferred", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const seven = values.const(7);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), read),
    stateWrite(gprChannel("eax"), seven),
    stateWrite(gprChannel("ecx"), read)
  ]);

  // The read materializes at its first use and tees; the later use replays
  // the local, so the store in between clobbers nothing it observes.
  strictEqual(analysis.outputPlacement(read).kind, "deferToUse");
});

test("a deferred output consumed only inside a fault body charges inputs there", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const guarded = values.const(0x3000);
  const loaded = values.addActionOutput();
  const fault = values.addActionOutput(fitsUnsigned(1));
  const analysis = analyze(values, [
    memoryRead(loaded, address, 32),
    memoryCheck(fault, guarded, 4, "write"),
    {
      kind: "if",
      condition: fault,
      thenBody: {
        actions: [
          stateWrite(gprChannel("eax"), loaded),
          pageFaultExit(guarded, true)
        ]
      }
    }
  ]);

  // The load's only consumer lives in the fault body, so the load executes
  // there — nothing materializes on the non-fault path — and its address
  // charges at that emission, counting at the owning if.
  strictEqual(analysis.outputPlacement(loaded).kind, "deferToUse");
  strictEqual(analysis.useCount(address), 1);
});

test("fault-only demand across sibling fault bodies sinks into each body", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const first = values.const(0x3000);
  const second = values.const(0x4000);
  const loaded = values.addActionOutput();
  const faultA = values.addActionOutput(fitsUnsigned(1));
  const faultB = values.addActionOutput(fitsUnsigned(1));
  const firstBody = {
    actions: [
      stateWrite(gprChannel("eax"), loaded),
      pageFaultExit(first, true)
    ]
  };
  const secondBody = {
    actions: [
      stateWrite(gprChannel("ebx"), loaded),
      pageFaultExit(second, true)
    ]
  };
  const analysis = analyze(values, [
    memoryRead(loaded, address, 32),
    memoryCheck(faultA, first, 4, "write"),
    { kind: "if", condition: faultA, thenBody: firstBody },
    memoryCheck(faultB, second, 4, "write"),
    { kind: "if", condition: faultB, thenBody: secondBody }
  ]);

  // The enclosing scope has no demand of its own, so it hosts no emission:
  // the load sinks into each fault body, and the address charges once per
  // emission.
  deepStrictEqual(analysis.outputPlacement(loaded), {
    kind: "deferToUse",
    emissions: [
      { anchor: "use", body: firstBody, uses: 1 },
      { anchor: "use", body: secondBody, uses: 1 }
    ]
  });
  strictEqual(analysis.useCount(loaded), 2);
  strictEqual(analysis.useCount(address), 2);
});

test("a direct use behind a demanding fault body emits once at the body's entry", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const address = values.const(0x2000);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const faultBody = {
    actions: [
      stateWrite(lazyFlagsAChannel, read),
      pageFaultExit(address, true)
    ]
  };
  const analysis = analyze(values, [
    stateRead(read, gprChannel("ebx")),
    memoryCheck(fault, address, 4, "write"),
    { kind: "if", condition: fault, thenBody: faultBody },
    stateWrite(lazyFlagsAChannel, read)
  ]);

  // The scope's own flush demands the read after the fault body, so its
  // flow pays for the value either way: one emission at the body's entry
  // serves the fault flush and the completed flush from one local.
  deepStrictEqual(analysis.outputPlacement(read), {
    kind: "deferToUse",
    emissions: [{ anchor: "bodyEntry", body: faultBody, uses: 2 }]
  });
});

test("a body restoring a channel captures the read feeding its deferred load", () => {
  const values = new ValueTable();
  const base = values.addActionOutput();
  const guarded = values.const(0x3000);
  const five = values.const(5);
  const loaded = values.addActionOutput();
  const fault = values.addActionOutput(fitsUnsigned(1));
  const analysis = analyze(values, [
    stateRead(base, gprChannel("ebx")),
    memoryRead(loaded, base, 32),
    memoryCheck(fault, guarded, 4, "write"),
    {
      kind: "if",
      condition: fault,
      thenBody: {
        actions: [
          stateWrite(gprChannel("ebx"), five),
          stateWrite(gprChannel("eax"), loaded),
          pageFaultExit(guarded, true)
        ]
      }
    }
  ]);

  // Re-emitting the load inside the body consumes its address there, and
  // the body restores ebx: the ebx read pins to its action point while the
  // load itself still sinks into the fault body.
  strictEqual(analysis.outputPlacement(loaded).kind, "deferToUse");
  strictEqual(analysis.outputPlacement(base).kind, "captureAtProducer");
});

test("an overlapping partial-channel store captures a wider read used later", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const low = values.const(0x1234);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ax"), low),
    stateWrite(gprChannel("ebx"), read)
  ]);

  strictEqual(analysis.outputPlacement(read).kind, "captureAtProducer");
});

test("a store at the value's final use leaves the read deferred", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("eax"), sum)
  ]);

  // The operand is pushed before the store executes.
  strictEqual(analysis.outputPlacement(read).kind, "deferToUse");
});

test("a dead static read counts zero, has no last use, and stays deferred", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const seven = values.const(7);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("eax"), seven)
  ]);

  strictEqual(analysis.useCount(read), 0);
  strictEqual(analysis.outputPlacement(read).kind, "deferToUse");
});

test("analysis rejects unknown value ids", () => {
  const values = new ValueTable();
  const analysis = analyze(values, []);

  throws(() => analysis.useCount(0), /unknown value id 0/);
  throws(() => analysis.outputPlacement(0), /unknown value id 0/);
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
              pageFaultExit(address)
            ]
          }
        }
      ]),
    /created after its output/
  );
});

test("a switch charges its selector and captures its output at the producer", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const first = values.const(11);
  const second = values.const(42);
  const fallback = values.const(99);
  const output = values.addActionOutput();
  const analysis = analyze(
    values,
    [
      {
        kind: "switch",
        selector,
        output,
        cases: [
          { match: 0, body: { actions: [], result: first } },
          { match: 2, body: { actions: [], result: second } }
        ],
        defaultBody: { actions: [], result: fallback }
      }
    ],
    [output]
  );

  strictEqual(analysis.useCount(selector), 1);
  strictEqual(analysis.outputPlacement(output).kind, "captureAtProducer");

  // The demanded output charges each body's result at its fallthrough.
  strictEqual(analysis.useCount(first), 1);
  strictEqual(analysis.useCount(second), 1);
  strictEqual(analysis.useCount(fallback), 1);
});

test("arm-local read demand stays in its arm", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const formula = values.binary("add", read, one);
  const fallback = values.const(0);
  const output = values.addActionOutput();
  const armBody = { actions: [stateRead(read, gprChannel("ebx"))], result: formula };
  const analysis = analyze(
    values,
    [
      {
        kind: "switch",
        selector,
        output,
        cases: [{ match: 0, body: armBody }],
        defaultBody: { actions: [], result: fallback }
      }
    ],
    [output]
  );

  // The read executes inside its arm, at the formula's use; nothing
  // materializes on the other paths.
  deepStrictEqual(analysis.outputPlacement(read), {
    kind: "deferToUse",
    emissions: [{ anchor: "use", body: armBody, uses: 1 }]
  });
  strictEqual(analysis.useCount(formula), 1);
});

test("a parent compound consumed by two arms charges once at the switch", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const base = values.external(1);
  const shared = values.binary("add", base, values.const(5));
  const fallback = values.const(0);
  const output = values.addActionOutput();
  const analysis = analyze(
    values,
    [
      {
        kind: "switch",
        selector,
        output,
        cases: [
          { match: 0, body: { actions: [], result: shared } },
          { match: 1, body: { actions: [], result: shared } }
        ],
        defaultBody: { actions: [], result: fallback }
      }
    ],
    [output]
  );

  // Both arms replay one capture made before the switch: two uses of the
  // compound, but its children charge once, at the owning switch.
  strictEqual(analysis.useCount(shared), 2);
  strictEqual(analysis.useCount(base), 1);
});

test("a dead switch output leaves pure arms unemitted", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const formula = values.binary("add", read, one);
  const fallback = values.const(0);
  const output = values.addActionOutput();
  const analysis = analyze(values, [
    {
      kind: "switch",
      selector,
      output,
      cases: [{ match: 0, body: { actions: [stateRead(read, gprChannel("ebx"))], result: formula } }],
      defaultBody: { actions: [], result: fallback }
    }
  ]);

  // The switch still selects, but nothing demands its output, so no arm
  // result — and no pure arm read — is ever charged.
  strictEqual(analysis.useCount(selector), 1);
  strictEqual(analysis.useCount(output), 0);
  strictEqual(analysis.useCount(formula), 0);
  strictEqual(analysis.useCount(read), 0);
  strictEqual(analysis.outputPlacement(read).kind, "deferToUse");
});

test("an exported output keeps an otherwise dead value live", () => {
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
  strictEqual(analysis.outputPlacement(read).kind, "deferToUse");
});

test("an exported read crossing an overlapping store captures", () => {
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
  // boundary would observe the new eax: the read captures.
  strictEqual(analysis.outputPlacement(read).kind, "captureAtProducer");
});

test("a pure read consumed only inside a loop body anchors at the loop entry", () => {
  const values = new ValueTable();
  const readOut = values.addActionOutput(fitsUnsigned(1));
  const loopInput = values.addLoopInput();
  const update = values.binary("add", loopInput, readOut);
  const loopBody = {
    actions: [
      stateWrite(gprChannel("ebx"), update),
      { kind: "loopContinue", updates: [update] } as const
    ]
  };
  const analysis = analyze(values, [
    stateRead(readOut, flagChannel("DF")),
    {
      kind: "loop",
      carried: [{ channel: gprChannel("eax"), seed: values.const(0), loopInput }],
      body: loopBody
    },
    hostExit()
  ]);
  const placement = analysis.outputPlacement(readOut);

  // The op never sinks into the body — it would re-execute per iteration.
  strictEqual(placement.kind, "deferToUse");
  deepStrictEqual(
    placement.kind === "deferToUse" ? placement.emissions : [],
    [{ anchor: "bodyEntry", body: loopBody, uses: 1 }]
  );
});

test("a producer whose reads the loop body writes captures at its action point", () => {
  const values = new ValueTable();
  const readOut = values.addActionOutput();
  const loopInput = values.addLoopInput();
  const update = values.binary("add", loopInput, readOut);
  const analysis = analyze(values, [
    stateRead(readOut, gprChannel("ebx")),
    {
      kind: "loop",
      carried: [{ channel: gprChannel("eax"), seed: values.const(0), loopInput }],
      body: {
        actions: [
          stateWrite(gprChannel("ebx"), update),
          { kind: "loopContinue", updates: [update] } as const
        ]
      }
    },
    hostExit()
  ]);

  strictEqual(analysis.outputPlacement(readOut).kind, "captureAtProducer");
});
