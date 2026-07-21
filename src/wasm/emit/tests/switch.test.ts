import { ok, strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { RegionBuilder } from "#ir/region-builder.js";
import { gprChannel } from "#core/state/channels.js";
import { coreStateFields } from "#core/state/layout.js";
import { cpuStateAccess } from "#cpu/state.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import {
  operandRead,
  operandWrite
} from "#ir/tests/storage-op-helpers.js";
import { wasmOpcode } from "#compiler/encoder/types.js";
import { wasmBodyLocalCount, wasmBodyOpcodes } from "#compiler/encoder/tests/body-opcodes.js";
import { ProgramBuilder } from "#compiler/program/builder.js";
import { encodeProgram } from "#compiler/program/encode.js";
import { functionType } from "#compiler/program/function-type.js";
import {
  exportRef,
  functionRef,
  signatureRef
} from "#compiler/program/refs.js";
import {
  readWasmCpuStateChannel,
  writeWasmCpuStateSnapshot
} from "#test/support/cpu-state.js";
import { instantiateIrBlock, irBlockBody, irBlockCompleted } from "./harness.js";
import {
  finishControl,
  ifControl,
  switchControl
} from "#compiler/ir/controls/index.js";

// The value switch: br_table dispatch over one block per case plus default
// plus a join, with the selected arm's result delivered as the output.

test("a switch selects arms by match and falls back to the default", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const first = values.const(11);
  const second = values.const(42);
  const fallback = values.const(99);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            { matches: [0], body: { nodes: [], result: first } },
            { matches: [2], body: { nodes: [], result: second } }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        operandWrite(state.gpr("eax"), output)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block, 1);
  const expectations = [
    [0, 11],
    [2, 42],
    // A hole in the dense table and an out-of-range selector both land on
    // the default.
    [1, 99],
    [7, 99]
  ] as const;

  for (const [selectorValue, expected] of expectations) {
    strictEqual(run(selectorValue), irBlockCompleted);
    strictEqual(
      readWasmCpuStateChannel(stateView, gprChannel("eax")),
      expected,
      `selector ${selectorValue}`
    );
  }
});

test("a control-only switch routes several matches through one emitted body", async () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const selector = values.external(0);

  builder.switchControl(
    selector,
    [{
      matches: [1, 3, 5],
      build: (arm) => {
        const state = cpuStateAccess.bind(arm);

        state.write(state.gpr("eax"), arm.values.const(11));
      }
    }],
    (fallback) => {
      const state = cpuStateAccess.bind(fallback);

      state.write(state.gpr("eax"), fallback.values.const(99));
    }
  );

  const block: IrBlock = { values, body: builder.build() };
  const encoded = irBlockBody(block, 1).bytes;
  const opcodes = wasmBodyOpcodes(encoded);

  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Store).length, 2);
  strictEqual(wasmBodyLocalCount(encoded), 0);

  const { stateView, run } = await instantiateIrBlock(block, 1);

  for (const selectorValue of [1, 3, 5]) {
    writeWasmCpuStateSnapshot(stateView, { eax: 0 });
    strictEqual(run(selectorValue), irBlockCompleted);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  }
  for (const selectorValue of [0, 2, 4, 7]) {
    writeWasmCpuStateSnapshot(stateView, { eax: 0 });
    strictEqual(run(selectorValue), irBlockCompleted);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 99);
  }
});

test("nested completing switches seal a defined function result", async () => {
  const program = new ProgramBuilder();
  const entryType = functionType(["i32"], ["i64"]);
  const entrySignature = signatureRef("test.completing-switch-signature");

  program.signature({ ref: entrySignature, type: entryType });
  const entry = program.defineFunction({
    ref: functionRef("test.completing-switch"),
    signature: entrySignature,
    effects: { reads: [], writes: [] }
  }, (fn) => {
    const selector = fn.parameters[0];

    if (selector === undefined) {
      throw new Error("missing switch selector");
    }
    fn.region.switchControl(selector, [{
      matches: [1, 3],
      build: (outerArm) => outerArm.switchControl(selector, [{
        matches: [1],
        build: (innerArm) => innerArm.return([innerArm.values.const64(11n)])
      }], (innerDefault) => {
        innerDefault.return([innerDefault.values.const64(13n)]);
      })
    }], (outerDefault) => {
      outerDefault.return([outerDefault.values.const64(99n)]);
    });
  });
  program.exportFunction({
    ref: exportRef("test.completing-switch-export"),
    name: "run",
    target: entry.ref
  });

  const encoded = encodeProgram(program.finish());

  strictEqual(WebAssembly.validate(encoded), true);
  const instance = await WebAssembly.instantiate(
    await WebAssembly.compile(encoded)
  );
  const run = instance.exports.run;

  if (typeof run !== "function") {
    throw new Error("missing completing-switch export");
  }
  strictEqual(run(1), 11n);
  strictEqual(run(3), 13n);
  strictEqual(run(7), 99n);
});

test("sequential switch joins reuse one physical local", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const firstCase = values.const(11);
  const firstFallback = values.const(12);
  const secondCase = values.const(21);
  const secondFallback = values.const(22);
  const firstOutput = values.addNodeOutput();
  const secondOutput = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output: firstOutput,
          cases: [{ matches: [0], body: { nodes: [], result: firstCase } }],
          defaultBody: { nodes: [], result: firstFallback }
        }),
        operandWrite(state.gpr("eax"), firstOutput),
        switchControl.create({
          selector,
          output: secondOutput,
          cases: [{ matches: [0], body: { nodes: [], result: secondCase } }],
          defaultBody: { nodes: [], result: secondFallback }
        }),
        operandWrite(state.gpr("ebx"), secondOutput)
      ]
    }
  };
  const encoded = irBlockBody(block, 1).bytes;

  strictEqual(wasmBodyLocalCount(encoded), 1);

  const { stateView, run } = await instantiateIrBlock(block, 1);

  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 21);

  strictEqual(run(7), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 12);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 22);
});

test("an impossible default lowers to unreachable and traps", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const first = values.const(11);
  const impossible = values.unreachable();
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [{ matches: [0], body: { nodes: [], result: first } }],
          defaultBody: { nodes: [], result: impossible }
        }),
        operandWrite(state.gpr("eax"), output)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block, 1);

  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 11);
  throws(() => run(5), WebAssembly.RuntimeError);
});

test("an arm-local compound over an arm-local read computes inside the arm", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const read = values.addNodeOutput();
  const formula = values.binary("add", read, values.const(1));
  const fallback = values.const(99);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            {
              matches: [0],
              body: { nodes: [operandRead(read, state.gpr("ebx"))], result: formula }
            }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        operandWrite(state.gpr("eax"), output)
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 1).bytes);

  // No if-chain lowering, one br_table; the ebx load sits inside the arm,
  // after dispatch — never captured in the parent.
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.if), false);
  ok(opcodes.indexOf(wasmOpcode.i32Load) > opcodes.indexOf(wasmOpcode.brTable));

  const { stateView, run } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateSnapshot(stateView, { ebx: 41 });
  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
});

test("a parent compound consumed by two arms captures once before the switch", async () => {
  const values = new ValueTable();
  values.const(0);
  const builder = new RegionBuilder(values);
  const state = cpuStateAccess.bind(builder);
  const selector = values.external(0);
  const input = values.external(1);
  const increment = values.const(5);
  const shared = values.binary("add", input, increment);
  const output = builder.switch(
    selector,
    [
      {
        match: 0,
        build: (arm) => arm.values.binary("add", input, increment)
      },
      {
        match: 1,
        build: (arm) => arm.values.binary("add", input, increment)
      }
    ],
    (fallback) => fallback.values.const(99)
  );

  strictEqual(values.binary("add", input, increment), shared);

  state.write(state.gpr("eax"), output);
  const block: IrBlock = { values, body: builder.build() };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);

  // One computation, captured before dispatch and replayed by each arm.
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.i32Add).length, 1);
  ok(opcodes.indexOf(wasmOpcode.i32Add) < opcodes.indexOf(wasmOpcode.brTable));

  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(run(1, 37), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
});

test("three sibling switch arms keep equal recipes after dispatch", async () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const state = cpuStateAccess.bind(builder);
  const selector = values.external(0);
  const input = values.external(1);
  const increment = values.const(1);
  const armValues: ValueId[] = [];
  const output = builder.switch(
    selector,
    [0, 1, 2].map((match) => ({
      match,
      build: (arm: RegionBuilder) => {
        const value = arm.values.binary("add", input, increment);

        armValues.push(value);
        return value;
      }
    })),
    (fallback) => fallback.values.const(7)
  );

  strictEqual(new Set(armValues).size, 3);
  state.write(state.gpr("eax"), output);
  const block: IrBlock = { values, body: builder.build() };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);
  const dispatchIndex = opcodes.indexOf(wasmOpcode.brTable);
  const addIndexes = opcodes.flatMap((opcode, index) =>
    opcode === wasmOpcode.i32Add ? [index] : []
  );

  strictEqual(dispatchIndex >= 0, true);
  strictEqual(addIndexes.length, 3);
  strictEqual(addIndexes.every((index) => index > dispatchIndex), true);

  const { stateView, run } = await instantiateIrBlock(block, 2);

  for (const selected of [0, 1, 2]) {
    strictEqual(run(selected, 41), irBlockCompleted);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
  }
  strictEqual(run(9, 41), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
});

test("identical trapping recipes authored by switch arms remain after dispatch", async () => {
  const values = new ValueTable();
  const builder = new RegionBuilder(values);
  const state = cpuStateAccess.bind(builder);
  const selector = values.external(0);
  const dividend = values.external(1);
  const divisor = values.external(2);
  let firstQuotient: ValueId | undefined;
  let secondQuotient: ValueId | undefined;
  const output = builder.switch(
    selector,
    [
      {
        match: 0,
        build: (arm) => {
          firstQuotient = arm.values.binary("div_u", dividend, divisor);
          return firstQuotient;
        }
      },
      {
        match: 1,
        build: (arm) => {
          secondQuotient = arm.values.binary("div_u", dividend, divisor);
          return secondQuotient;
        }
      }
    ],
    (fallback) => fallback.values.const(7)
  );

  if (firstQuotient === undefined || secondQuotient === undefined) {
    throw new Error("switch arm recipes were not built");
  }
  strictEqual(firstQuotient === secondQuotient, false);

  state.write(state.gpr("eax"), output);
  const block: IrBlock = { values, body: builder.build() };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 3).bytes);
  const dispatchIndex = opcodes.indexOf(wasmOpcode.brTable);
  const divideIndexes = opcodes.flatMap((opcode, index) =>
    opcode === wasmOpcode.i32DivU ? [index] : []
  );

  strictEqual(dispatchIndex >= 0, true);
  strictEqual(divideIndexes.length, 2);
  strictEqual(divideIndexes.every((index) => index > dispatchIndex), true);

  const { stateView, run } = await instantiateIrBlock(block, 3);

  strictEqual(run(9, 1, 0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  for (const selected of [0, 1]) {
    strictEqual(run(selected, 84, 2), irBlockCompleted);
    strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 42);
    throws(() => run(selected, 1, 0), WebAssembly.RuntimeError);
  }
});

test("a switch captures a state snapshot before the selected arm writes it", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const snapshot = values.addNodeOutput();
  const caseResult = values.const(10);
  const defaultResult = values.const(11);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        operandRead(snapshot, state.gpr("eax")),
        switchControl.create({
          selector,
          output,
          cases: [{
            matches: [0],
            body: {
              nodes: [
                operandWrite(state.gpr("eax"), values.const(5)),
                operandWrite(state.gpr("ebx"), snapshot)
              ],
              result: caseResult
            }
          }],
          defaultBody: {
            nodes: [
              operandWrite(state.gpr("eax"), values.const(9)),
              operandWrite(state.gpr("ecx"), snapshot)
            ],
            result: defaultResult
          }
        }),
        operandWrite(state.gpr("edx"), output)
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 1).bytes);

  strictEqual(opcodes.indexOf(wasmOpcode.localSet) < opcodes.indexOf(wasmOpcode.brTable), true);

  const { stateView, run } = await instantiateIrBlock(block, 1);

  writeWasmCpuStateSnapshot(stateView, { eax: 41, ebx: 0, ecx: 0, edx: 0 });
  strictEqual(run(0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 5);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ebx")), 41);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 10);

  writeWasmCpuStateSnapshot(stateView, { eax: 42, ebx: 0, ecx: 0, edx: 0 });
  strictEqual(run(7), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 9);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("ecx")), 42);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("edx")), 11);
});

test("a dead switch output emits no arm values but keeps the impossible default", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const read = values.addNodeOutput();
  const readFormula = values.binary("add", read, values.const(1));
  const shared = values.binary("add", values.external(1), values.const(5));
  const impossible = values.unreachable();
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            {
              matches: [0],
              body: { nodes: [operandRead(read, state.gpr("ebx"))], result: readFormula }
            },
            { matches: [1], body: { nodes: [], result: shared } }
          ],
          defaultBody: { nodes: [], result: impossible }
        })
      ]
    }
  };
  const opcodes = wasmBodyOpcodes(irBlockBody(block, 2).bytes);

  // Nothing demands the output: the dispatch shell remains, but no arm
  // result materializes — neither the pure arm read nor the parent-context
  // compound — while the impossible default still traps.
  strictEqual(opcodes.filter((opcode) => opcode === wasmOpcode.brTable).length, 1);
  strictEqual(opcodes.includes(wasmOpcode.i32Load), false);
  strictEqual(opcodes.includes(wasmOpcode.i32Add), false);

  const { run } = await instantiateIrBlock(block, 2);

  strictEqual(run(0, 37), irBlockCompleted);
  strictEqual(run(1, 37), irBlockCompleted);
  throws(() => run(9, 37), WebAssembly.RuntimeError);
});

test("a dispatch inside an arm escapes through the switch's labels", async () => {
  const values = new ValueTable();
  values.const(0);
  const state = cpuStateAccess.bind(new RegionBuilder(values));
  const selector = values.external(0);
  const condition = values.external(1);
  const target = values.const(0x2000);
  const delivered = values.const(7);
  const fallback = values.const(99);
  const output = values.addNodeOutput();
  const block: IrBlock = {
    values,
    body: {
      nodes: [
        switchControl.create({
          selector,
          output,
          cases: [
            {
              matches: [0],
              body: {
                nodes: [
                  ifControl.create({
                    condition,
                    thenBody: {
                      nodes: [
                        operandWrite(state.field(coreStateFields.eip), target),
                        finishControl.create({
                          finish: { kind: "dispatch", targetEip: target }
                        })
                      ]
                    }
                  })
                ],
                result: delivered
              }
            }
          ],
          defaultBody: { nodes: [], result: fallback }
        }),
        operandWrite(state.gpr("eax"), output)
      ]
    }
  };
  const { stateView, run } = await instantiateIrBlock(block, 2);

  strictEqual(run(0, 0), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);

  // The dispatch escapes the switch's labels before the arm delivers:
  // eax keeps its old value and eip carries the flushed target.
  strictEqual(run(0, 1), irBlockCompleted);
  strictEqual(readWasmCpuStateChannel(stateView, gprChannel("eax")), 7);
  strictEqual(readWasmCpuStateChannel(stateView, coreStateFields.eip), 0x2000);
});
