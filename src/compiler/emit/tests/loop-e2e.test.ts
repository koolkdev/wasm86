import { strictEqual } from "node:assert";
import { test } from "node:test";

import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import { cpuStateAccess } from "#test/support/execution-model.js";
import type { FunctionBuilder } from "#compiler/ir/builder/function.js";
import {
  operandRead,
  operandWrite
} from "#test/support/storage-operations.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import {
  completedTestFunction,
  testFunctionCompleted,
  instantiateTestFunction,
  type TestFunction
} from "./harness.js";
import {
  ifControl,
  loopContinueControl,
  loopControl
} from "#compiler/ir/controls/index.js";

// The loop machinery end to end: carried cells in locals, the continue's
// parallel back-edge assignment, loop-invariant hoisting, and the fused rep
// producer through the emitter into a running module.

const dispatchEip = 0x2000;

function loopFunction(
  parameterCount: number,
  build: (fn: FunctionBuilder) => void
): TestFunction {
  return completedTestFunction(parameterCount, (fn) => {
    build(fn);
    const state = cpuStateAccess.bind(fn.region);

    state.write(
      state.field(coreStateFields.eip),
      fn.values.const(dispatchEip)
    );
  });
}

// One swap per completed iteration: the back edge must assign all cells in
// parallel — a sequential rewrite would collapse both registers to one value.
function swapLoopFunction(): TestFunction {
  return loopFunction(0, (fn) => {
    const { values } = fn;
    const state = cpuStateAccess.bind(fn.region);

    values.const(0);
    const aSeed = values.addNodeOutput();
    const bSeed = values.addNodeOutput();
    const nSeed = values.addNodeOutput();
    const aInput = values.addLoopInput();
    const bInput = values.addLoopInput();
    const nInput = values.addLoopInput();
    const remaining = values.binary("sub", nInput, values.const(1));

    fn.region.extend([
      operandRead(aSeed, state.gpr("eax")),
      operandRead(bSeed, state.gpr("ebx")),
      operandRead(nSeed, state.gpr("ecx")),
      loopControl.create({
        carried: [
          { seed: aSeed, loopInput: aInput },
          { seed: bSeed, loopInput: bInput },
          { seed: nSeed, loopInput: nInput }
        ],
        body: {
          nodes: [
            ifControl.create({
              condition: values.compare(32, "ne", remaining, values.const(0)),
              thenBody: {
                nodes: [loopContinueControl.create({
                  updates: [bInput, aInput, remaining]
                })]
              }
            }),
            operandWrite(state.gpr("eax"), bInput),
            operandWrite(state.gpr("ebx"), aInput),
            operandWrite(state.gpr("ecx"), remaining)
          ]
        }
      })
    ]);
  });
}

async function runSwap(iterations: number): Promise<DataView> {
  const { stateView, run } = await instantiateTestFunction(swapLoopFunction());

  writeWasmCpuStateSnapshot(stateView, { eax: 0x11, ebx: 0x22, ecx: iterations });
  strictEqual(run(), testFunctionCompleted);
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
  const fixture = loopFunction(0, (fn) => {
    const { values } = fn;
    const state = cpuStateAccess.bind(fn.region);

    values.const(0);
    const invariant = values.addNodeOutput();
    const sumSeed = values.addNodeOutput();
    const nSeed = values.addNodeOutput();
    const sumInput = values.addLoopInput();
    const nInput = values.addLoopInput();
    const total = values.binary("add", sumInput, invariant);
    const remaining = values.binary("sub", nInput, values.const(1));

    fn.region.extend([
      operandRead(invariant, state.gpr("edx")),
      operandRead(sumSeed, state.gpr("eax")),
      operandRead(nSeed, state.gpr("ecx")),
      loopControl.create({
        carried: [
          { seed: sumSeed, loopInput: sumInput },
          { seed: nSeed, loopInput: nInput }
        ],
        body: {
          nodes: [
            ifControl.create({
              condition: values.compare(32, "ne", remaining, values.const(0)),
              thenBody: {
                nodes: [loopContinueControl.create({
                  updates: [total, remaining]
                })]
              }
            }),
            operandWrite(state.gpr("eax"), total),
            operandWrite(state.gpr("ecx"), remaining)
          ]
        }
      })
    ]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ecx: 5, edx: 7 });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 35);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
});

test("a pure invariant evaluates before the loop", async () => {
  const fixture = loopFunction(1, (fn) => {
    const { values } = fn;
    const state = cpuStateAccess.bind(fn.region);

    values.const(0);
    const invariant = values.binary("add", fn.parameters[0]!, values.const(1));
    const countSeed = values.addNodeOutput();
    const countInput = values.addLoopInput();
    const remaining = values.binary("sub", countInput, values.const(1));

    fn.region.extend([
      operandRead(countSeed, state.gpr("ecx")),
      loopControl.create({
        carried: [{ seed: countSeed, loopInput: countInput }],
        body: {
          nodes: [
            operandWrite(state.gpr("eax"), invariant),
            ifControl.create({
              condition: values.compare(32, "ne", remaining, values.const(0)),
              thenBody: {
                nodes: [loopContinueControl.create({ updates: [remaining] })]
              }
            }),
            operandWrite(state.gpr("ecx"), remaining)
          ]
        }
      })
    ]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ecx: 3 });
  strictEqual(run(41), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
});

test("an outer value captures at each inner loop entry", async () => {
  const fixture = loopFunction(0, (fn) => {
    const { values } = fn;
    const state = cpuStateAccess.bind(fn.region);

    values.const(0);
    const outerSeed = values.addNodeOutput();
    const outerInput = values.addLoopInput();
    const innerInput = values.addLoopInput();
    const one = values.const(1);
    const adjusted = values.binary("add", outerInput, values.const(10));
    const outerRemaining = values.binary("sub", outerInput, one);
    const innerRemaining = values.binary("sub", innerInput, one);

    fn.region.extend([
      operandRead(outerSeed, state.gpr("ecx")),
      loopControl.create({
        carried: [{ seed: outerSeed, loopInput: outerInput }],
        body: {
          nodes: [
            loopControl.create({
              carried: [{ seed: values.const(2), loopInput: innerInput }],
              body: {
                nodes: [
                  operandWrite(state.gpr("eax"), adjusted),
                  ifControl.create({
                    condition: values.compare(32, "ne", innerRemaining, values.const(0)),
                    thenBody: {
                      nodes: [loopContinueControl.create({
                        updates: [innerRemaining]
                      })]
                    }
                  })
                ]
              }
            }),
            ifControl.create({
              condition: values.compare(32, "ne", outerRemaining, values.const(0)),
              thenBody: {
                nodes: [loopContinueControl.create({
                  updates: [outerRemaining]
                })]
              }
            }),
            operandWrite(state.gpr("ecx"), outerRemaining)
          ]
        }
      })
    ]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0, ebx: 0, ecx: 3 });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 0);
});

test("an outer capture survives nested loops and both back edges", async () => {
  const fixture = loopFunction(0, (fn) => {
    const { values } = fn;
    const state = cpuStateAccess.bind(fn.region);

    values.const(0);
    const invariant = values.addNodeOutput();
    const outerSeed = values.addNodeOutput();
    const transient = values.addNodeOutput();
    const outerInput = values.addLoopInput();
    const innerInput = values.addLoopInput();
    const outerRemaining = values.binary("sub", outerInput, values.const(1));
    const innerRemaining = values.binary("sub", innerInput, values.const(1));

    fn.region.extend([
      operandRead(invariant, state.gpr("edx")),
      operandRead(outerSeed, state.gpr("ecx")),
      loopControl.create({
        carried: [{ seed: outerSeed, loopInput: outerInput }],
        body: {
          nodes: [
            loopControl.create({
              carried: [{ seed: values.const(2), loopInput: innerInput }],
              body: {
                nodes: [
                  operandWrite(state.gpr("ebx"), invariant),
                  operandRead(transient, state.gpr("esi")),
                  operandWrite(state.gpr("edi"), transient),
                  operandWrite(state.gpr("ebp"), transient),
                  ifControl.create({
                    condition: values.compare(
                      32,
                      "ne",
                      innerRemaining,
                      values.const(0)
                    ),
                    thenBody: {
                      nodes: [loopContinueControl.create({
                        updates: [innerRemaining]
                      })]
                    }
                  })
                ]
              }
            }),
            ifControl.create({
              condition: values.compare(
                32,
                "ne",
                outerRemaining,
                values.const(0)
              ),
              thenBody: {
                nodes: [loopContinueControl.create({
                  updates: [outerRemaining]
                })]
              }
            }),
            operandWrite(state.gpr("eax"), invariant)
          ]
        }
      })
    ]);
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, {
    eax: 0,
    ebx: 0,
    ecx: 3,
    edx: 7,
    ebp: 0,
    esi: 0x55,
    edi: 0
  });
  strictEqual(run(), testFunctionCompleted);
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
  const fixture = loopFunction(0, (fn) => {
    const { region, values } = fn;
    const state = cpuStateAccess.bind(region);
    const nSeed = state.read(state.gpr("ecx"));
    const cell = region.cell(nSeed);

    region.loop([], (loop) => {
      const readOut = loop.read(cell);
      const next = values.binary("sub", readOut, values.const(1));

      loop.write(cell, next);
      loop.if(
        values.compare(32, "ne", next, values.const(0)),
        (taken) => taken.loopContinue([])
      );
    });
    const postOut = region.read(cell);

    state.write(
      state.gpr("eax"),
      values.binary("add", postOut, values.const(100))
    );
  });
  const { stateView, run } = await instantiateTestFunction(fixture);

  writeWasmCpuStateSnapshot(stateView, { eax: 0xdead, ecx: 5 });
  strictEqual(run(), testFunctionCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 100);
  // Nothing was carried: the loop leaves ecx untouched.
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 5);
});
