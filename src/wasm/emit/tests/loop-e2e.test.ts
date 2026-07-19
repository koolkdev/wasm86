import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { memBinding, staticMemSegment } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import { RegionBuilder } from "#ir/region-builder.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { repMovsSemantic } from "#core/semantics/strings.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  readWasmCpuStateChannel,
  readWasmCpuStateField,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  wasmBodyInstructions,
  wasmBodyOpcodes
} from "#compiler/encoder/tests/body-opcodes.js";
import { irBlockBody, irBlockCompleted, instantiateIrBlock } from "./harness.js";
import { stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";

// The loop machinery end to end: carried cells in locals, the continue's
// parallel back-edge assignment, loop-invariant hoisting, and the fused rep
// producer through the emitter into a running module.

const dispatchEip = 0x2000;

function loopBlock(values: ValueTable, actions: readonly Action[]): IrBlock {
  const eip = values.const(dispatchEip);

  return {
    values,
    body: {
      actions: [
        ...actions,
        { kind: "finish", finish: { kind: "dispatch", targetEip: eip } }
      ]
    }
  };
}

// One swap per completed iteration: the back edge must assign all cells in
// parallel — a sequential rewrite would collapse both registers to one value.
function swapLoopBlock(): IrBlock {
  const values = new ValueTable();
  const aSeed = values.addActionOutput();
  const bSeed = values.addActionOutput();
  const nSeed = values.addActionOutput();
  const aInput = values.addLoopInput();
  const bInput = values.addLoopInput();
  const nInput = values.addLoopInput();
  const remaining = values.binary("sub", nInput, values.const(1));

  return loopBlock(values, [
    stateRead(aSeed, gprChannel("eax")),
    stateRead(bSeed, gprChannel("ebx")),
    stateRead(nSeed, gprChannel("ecx")),
    {
      kind: "loop",
      carried: [
        { channel: gprChannel("eax"), seed: aSeed, loopInput: aInput },
        { channel: gprChannel("ebx"), seed: bSeed, loopInput: bInput },
        { channel: gprChannel("ecx"), seed: nSeed, loopInput: nInput }
      ],
      body: {
        actions: [
          {
            kind: "if",
            condition: values.compare(32, "ne", remaining, values.const(0)),
            thenBody: { actions: [{ kind: "loopContinue", updates: [bInput, aInput, remaining] }] }
          },
          stateWrite(gprChannel("eax"), bInput),
          stateWrite(gprChannel("ebx"), aInput),
          stateWrite(gprChannel("ecx"), remaining)
        ]
      }
    }
  ]);
}

async function runSwap(iterations: number): Promise<DataView> {
  const { stateView, run } = await instantiateIrBlock(swapLoopBlock());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11, ebx: 0x22, ecx: iterations });
  strictEqual(run(), irBlockCompleted);
  return stateView;
}

test("the back edge assigns all carried cells in parallel", async () => {
  const odd = await runSwap(5);

  strictEqual(readWasmCpuStateChannel(odd, gprChannel("eax")), 0x22);
  strictEqual(readWasmCpuStateChannel(odd, gprChannel("ebx")), 0x11);
  strictEqual(readWasmCpuStateChannel(odd, gprChannel("ecx")), 0);

  const even = await runSwap(2);

  strictEqual(readWasmCpuStateChannel(even, gprChannel("eax")), 0x11);
  strictEqual(readWasmCpuStateChannel(even, gprChannel("ebx")), 0x22);
});

// A loop-invariant producer materializes once at loop entry, and its local
// must survive every iteration even after its last statically counted use.
test("a hoisted loop-invariant value stays live across iterations", async () => {
  const values = new ValueTable();
  const invariant = values.addActionOutput();
  const sumSeed = values.addActionOutput();
  const nSeed = values.addActionOutput();
  const sumInput = values.addLoopInput();
  const nInput = values.addLoopInput();
  const total = values.binary("add", sumInput, invariant);
  const remaining = values.binary("sub", nInput, values.const(1));
  const block = loopBlock(values, [
    stateRead(invariant, gprChannel("edx")),
    stateRead(sumSeed, gprChannel("eax")),
    stateRead(nSeed, gprChannel("ecx")),
    {
      kind: "loop",
      carried: [
        { channel: gprChannel("eax"), seed: sumSeed, loopInput: sumInput },
        { channel: gprChannel("ecx"), seed: nSeed, loopInput: nInput }
      ],
      body: {
        actions: [
          {
            kind: "if",
            condition: values.compare(32, "ne", remaining, values.const(0)),
            thenBody: { actions: [{ kind: "loopContinue", updates: [total, remaining] }] }
          },
          stateWrite(gprChannel("eax"), total),
          stateWrite(gprChannel("ecx"), remaining)
        ]
      }
    }
  ]);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ecx: 5, edx: 7 });
  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 35);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
});

test("a pure invariant evaluates before the loop", async () => {
  const values = new ValueTable();
  const invariant = values.binary("add", values.external(0), values.const(1));
  const countSeed = values.addActionOutput();
  const countInput = values.addLoopInput();
  const remaining = values.binary("sub", countInput, values.const(1));
  const block = loopBlock(values, [
    stateRead(countSeed, gprChannel("ecx")),
    {
      kind: "loop",
      carried: [{ channel: gprChannel("ecx"), seed: countSeed, loopInput: countInput }],
      body: {
        actions: [
          stateWrite(gprChannel("eax"), invariant),
          {
            kind: "if",
            condition: values.compare(32, "ne", remaining, values.const(0)),
            thenBody: {
              actions: [{ kind: "loopContinue", updates: [remaining] }]
            }
          },
          stateWrite(gprChannel("ecx"), remaining)
        ]
      }
    }
  ]);
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 1).bytes);

  ok(opcodes.indexOf(wasmOpcode.i32Add) < opcodes.indexOf(wasmOpcode.loop));
  const { stateView, run } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ecx: 3 });
  strictEqual(run(41), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
});

test("an outer value captures at each inner loop entry", async () => {
  const values = new ValueTable();
  const outerSeed = values.addActionOutput();
  const outerInput = values.addLoopInput();
  const innerInput = values.addLoopInput();
  const one = values.const(1);
  const adjusted = values.binary("add", outerInput, values.const(10));
  const outerRemaining = values.binary("sub", outerInput, one);
  const innerRemaining = values.binary("sub", innerInput, one);
  const block = loopBlock(values, [
    stateRead(outerSeed, gprChannel("ecx")),
    {
      kind: "loop",
      carried: [{ channel: gprChannel("ecx"), seed: outerSeed, loopInput: outerInput }],
      body: {
        actions: [
          {
            kind: "loop",
            carried: [{
              channel: gprChannel("ebx"),
              seed: values.const(2),
              loopInput: innerInput
            }],
            body: {
              actions: [
                stateWrite(gprChannel("eax"), adjusted),
                {
                  kind: "if",
                  condition: values.compare(32, "ne", innerRemaining, values.const(0)),
                  thenBody: {
                    actions: [{ kind: "loopContinue", updates: [innerRemaining] }]
                  }
                }
              ]
            }
          },
          {
            kind: "if",
            condition: values.compare(32, "ne", outerRemaining, values.const(0)),
            thenBody: {
              actions: [{ kind: "loopContinue", updates: [outerRemaining] }]
            }
          },
          stateWrite(gprChannel("ecx"), outerRemaining)
        ]
      }
    }
  ]);
  const opcodes = wasmBodyOpcodes(irBlockBody(block).bytes);
  const loops = opcodes
    .map((opcode, index) => opcode === wasmOpcode.loop ? index : -1)
    .filter((index) => index !== -1);
  const add = opcodes.indexOf(wasmOpcode.i32Add);

  deepStrictEqual(loops.length, 2);
  ok(loops[0]! < add && add < loops[1]!);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ebx: 0, ecx: 3 });
  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
});

test("an outer capture survives nested loops and both back edges", async () => {
  const values = new ValueTable();
  const invariant = values.addActionOutput();
  const outerSeed = values.addActionOutput();
  const transient = values.addActionOutput();
  const outerInput = values.addLoopInput();
  const innerInput = values.addLoopInput();
  const outerRemaining = values.binary("sub", outerInput, values.const(1));
  const innerRemaining = values.binary("sub", innerInput, values.const(1));
  const block = loopBlock(values, [
    stateRead(invariant, gprChannel("edx")),
    stateRead(outerSeed, gprChannel("ecx")),
    {
      kind: "loop",
      carried: [{
        channel: gprChannel("ecx"),
        seed: outerSeed,
        loopInput: outerInput
      }],
      body: {
        actions: [
          {
            kind: "loop",
            carried: [{
              channel: gprChannel("ebx"),
              seed: values.const(2),
              loopInput: innerInput
            }],
            body: {
              actions: [
                stateWrite(gprChannel("ebx"), invariant),
                stateRead(transient, gprChannel("esi")),
                stateWrite(gprChannel("edi"), transient),
                stateWrite(gprChannel("ebp"), transient),
                {
                  kind: "if",
                  condition: values.compare(
                    32,
                    "ne",
                    innerRemaining,
                    values.const(0)
                  ),
                  thenBody: {
                    actions: [{
                      kind: "loopContinue",
                      updates: [innerRemaining]
                    }]
                  }
                }
              ]
            }
          },
          {
            kind: "if",
            condition: values.compare(
              32,
              "ne",
              outerRemaining,
              values.const(0)
            ),
            thenBody: {
              actions: [{
                kind: "loopContinue",
                updates: [outerRemaining]
              }]
            }
          },
          stateWrite(gprChannel("eax"), invariant)
        ]
      }
    }
  ]);
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0,
    ebx: 0,
    ecx: 3,
    edx: 7,
    ebp: 0,
    esi: 0x55,
    edi: 0
  });
  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebp")), 0x55);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edi")), 0x55);
});

// Semantic cells back onto plain wasm locals: the loop carries no architectural
// state, the cell advances per iteration, and a read after the loop sees the
// final value. The in-body read feeds uses past the cell.write, requiring
// capture-before-overwrite ordering.
test("cell locals carry loop state and survive to post-loop reads", async () => {
  const values = new ValueTable();
  const body = new RegionBuilder(values);
  const nSeed = values.addActionOutput();

  body.push(stateRead(nSeed, gprChannel("ecx")));
  const cell = body.cell(nSeed);

  body.loop([], (loop) => {
    const readOut = loop.read(cell);
    const next = values.binary("sub", readOut, values.const(1));

    loop.write(cell, next);
    loop.if(
      values.compare(32, "ne", next, values.const(0)),
      (taken) => taken.loopContinue([])
    );
  });
  const postOut = body.read(cell);

  body.push(
    stateWrite(
      gprChannel("eax"),
      values.binary("add", postOut, values.const(100))
    )
  );
  body.finish({ kind: "dispatch", targetEip: values.const(dispatchEip) });
  const block: IrBlock = { values, body: body.build() };
  const { stateView, run } = await instantiateIrBlock(block);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xdead, ecx: 5 });
  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 100);
  // Nothing was carried: the loop leaves ecx untouched.
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 5);
});

const repEip = 0x1000;
const repNextEip = 0x1002;

function repMovsdBlock(): IrBlock {
  const builder = createIrBlockBuilder();

  builder.addInstruction(
    repMovsSemantic(32),
    [
      memBinding({ base: "esi", index: undefined, scale: 1, disp: 0 }, staticMemSegment("ds")),
      memBinding({ base: "edi", index: undefined, scale: 1, disp: 0 }, staticMemSegment("es"))
    ],
    loc(repEip, repNextEip)
  );
  return builder.finish();
}

test("rep movsd runs its whole count in one dispatch with an exact count", async () => {
  const { stateView, guestView, run } = await instantiateIrBlock(repMovsdBlock());

  writeWasmCpuStateSnapshot(stateView, { ecx: 3, esi: 0x20, edi: 0x40, eip: repEip });
  guestView.setUint32(0x20, 0x1111_2222, true);
  guestView.setUint32(0x24, 0x3333_4444, true);
  guestView.setUint32(0x28, 0x5555_6666, true);

  strictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esi")), 0x2c);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edi")), 0x4c);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), repNextEip);
  strictEqual(readWasmCpuStateField(stateView, "instructionCount"), 3);
  deepStrictEqual(
    [0x40, 0x44, 0x48].map((address) => guestView.getUint32(address, true)),
    [0x1111_2222, 0x3333_4444, 0x5555_6666]
  );
});

test("a mid-string fault commits partial progress with eip at the rep", async () => {
  const { stateView, guestView, run } = await instantiateIrBlock(repMovsdBlock());
  const guestByteLength = guestView.byteLength;

  writeWasmCpuStateSnapshot(stateView, { ecx: 2, esi: 0x20, edi: guestByteLength - 4, eip: repEip });
  guestView.setUint32(0x20, 0x1111_2222, true);
  guestView.setUint32(0x24, 0x3333_4444, true);

  notStrictEqual(run(), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 1);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("esi")), 0x24);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edi")), guestByteLength);
  strictEqual(readWasmCpuStateChannel(stateView, eipChannel), repEip);
  // The count is not carried: a mid-rep fault reports the pre-rep count.
  strictEqual(readWasmCpuStateField(stateView, "instructionCount"), 0);
  strictEqual(guestView.getUint32(guestByteLength - 4, true), 0x1111_2222);
});

const stateLoadOpcodes: readonly number[] = [
  wasmOpcode.i32Load,
  wasmOpcode.i32Load8S,
  wasmOpcode.i32Load8U,
  wasmOpcode.i32Load16S,
  wasmOpcode.i32Load16U
];

test("rep movsd does not read cpu state inside the loop body", () => {
  const body = irBlockBody(repMovsdBlock()).bytes;
  const instructions = wasmBodyInstructions(body);
  const loopEntry = instructions.find((instruction) => instruction.opcode === wasmOpcode.loop);

  ok(loopEntry !== undefined, "the block contains a wasm loop");
  const loopEnd = matchingControlEnd(instructions, loopEntry.offset);

  ok(loopEnd !== undefined, "the wasm loop has a matching end");

  // The DF delta and every other loop-invariant read hoist; only guest
  // memory and the loop's own locals are touched per iteration.
  deepStrictEqual(
    instructions.filter(
      (instruction) =>
        instruction.offset > loopEntry.offset &&
        instruction.offset < loopEnd.offset &&
        instruction.memoryIndex === wasmMemoryIndex.cpuState &&
        stateLoadOpcodes.includes(instruction.opcode)
    ),
    []
  );
});

function matchingControlEnd(
  instructions: readonly ReturnType<typeof wasmBodyInstructions>[number][],
  controlOffset: number
): ReturnType<typeof wasmBodyInstructions>[number] | undefined {
  let depth = 0;

  for (const instruction of instructions) {
    if (instruction.offset <= controlOffset) {
      continue;
    }

    switch (instruction.opcode) {
      case wasmOpcode.block:
      case wasmOpcode.loop:
      case wasmOpcode.if:
        depth += 1;
        break;
      case wasmOpcode.end:
        if (depth === 0) {
          return instruction;
        }

        depth -= 1;
        break;
    }
  }

  return undefined;
}
