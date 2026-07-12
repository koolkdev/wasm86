import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { createIrBlockBuilder, staticInstructionLocation as loc } from "#ir/builder.js";
import { memBinding, staticMemSegment } from "#ir/operands.js";
import { eipChannel, gprChannel } from "#ir/slots.js";
import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { ValueTable } from "#ir/value-table.js";
import { repMovsSemantic } from "#core/semantics/strings.js";
import { wasmMemoryIndex } from "#wasm/abi.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import {
  readWasmCpuStateChannel,
  readWasmCpuStateField,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { wasmBodyInstructions } from "#compiler/encoder/tests/body-opcodes.js";
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

// Semantic vars back onto plain wasm locals: the loop carries no cells, the
// var advances per iteration, and a read after the loop sees the final
// value. The in-body read's value feeds uses past the var.write, pinning
// the capture-before-overwrite ordering.
test("var locals carry loop state and survive to post-loop reads", async () => {
  const values = new ValueTable();
  const nSeed = values.addActionOutput();
  const readOut = values.addActionOutput();
  const postOut = values.addActionOutput();
  const next = values.binary("sub", readOut, values.const(1));
  const block = loopBlock(values, [
    stateRead(nSeed, gprChannel("ecx")),
    { kind: "op", op: { kind: "var.write", variable: 0, value: nSeed } },
    {
      kind: "loop",
      carried: [],
      body: {
        actions: [
          { kind: "op", output: readOut, op: { kind: "var.read", variable: 0 } },
          { kind: "op", op: { kind: "var.write", variable: 0, value: next } },
          {
            kind: "if",
            condition: values.compare(32, "ne", next, values.const(0)),
            thenBody: { actions: [{ kind: "loopContinue", updates: [] }] }
          }
        ]
      }
    },
    { kind: "op", output: postOut, op: { kind: "var.read", variable: 0 } },
    stateWrite(gprChannel("eax"), values.binary("add", postOut, values.const(100)))
  ]);
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
