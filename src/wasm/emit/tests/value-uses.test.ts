import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import { gprChannel } from "#ir/slots.js";
import {
  memoryCheck,
  memoryRead,
  memoryWrite,
  stateRead,
  stateWrite
} from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { fitsUnsigned } from "#compiler/ir/values/width-bounds.js";
import { valueId } from "#compiler/ir/values/id.js";
import type { ValueId } from "#compiler/ir/values/types.js";
import { analyzeLiveness } from "#wasm/emit/liveness.js";
import { analyzeValueUses } from "#wasm/emit/value-uses.js";

function analyze(
  values: ValueTable,
  actions: readonly Action[],
  exportedOutputs: readonly (ValueId | number)[] = []
) {
  const block = { body: { actions }, values };
  const outputs = exportedOutputs.map(valueId);

  return analyzeValueUses(block, analyzeLiveness(block, outputs), outputs);
}

test("action operands count one use per consuming action", () => {
  const values = new ValueTable();
  const deadStateRead = values.addActionOutput();
  const address = values.const(0x1000);
  const deadMemoryRead = values.addActionOutput();
  const stored = values.const(1);
  const guarded = values.const(0x2000);
  const byteLength = values.const(4);
  const fault = values.addActionOutput(fitsUnsigned(1));
  const payload = values.const(7);
  const analysis = analyze(values, [
    stateRead(deadStateRead, gprChannel("eax")),
    memoryRead(deadMemoryRead, address, 32),
    memoryWrite(address, stored, 32),
    memoryCheck(fault, guarded, byteLength),
    {
      kind: "if",
      condition: fault,
      thenBody: {
        actions: [{
          kind: "finish",
          finish: {
            kind: "exit",
            exit: { class: "host", reason: "hostTrap", payload }
          }
        }]
      }
    }
  ]);

  // Both unused reads disappear. Only the memory store consumes the address.
  strictEqual(analysis.useCount(address), 1);
  strictEqual(analysis.useCount(stored), 1);
  strictEqual(analysis.useCount(guarded), 1);
  strictEqual(analysis.useCount(byteLength), 1);
  strictEqual(analysis.useCount(fault), 1);
  strictEqual(analysis.useCount(payload), 1);
  strictEqual(analysis.useCount(deadStateRead), 0);
  strictEqual(analysis.useCount(deadMemoryRead), 0);
});

test("a live output charges its inputs once however many sites consume it", () => {
  const values = new ValueTable();
  const address = values.const(0x2000);
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    memoryRead(loaded, address, 32),
    stateWrite(gprChannel("eax"), loaded),
    stateWrite(gprChannel("ebx"), loaded)
  ]);

  strictEqual(analysis.useCount(loaded), 2);
  strictEqual(analysis.useCount(address), 1);
});

test("an unused memory read does not retain its transitive input recipe", () => {
  const values = new ValueTable();
  const base = values.addActionOutput();
  const offset = values.const(8);
  const address = values.binary("add", base, offset);
  const loaded = values.addActionOutput();
  const analysis = analyze(values, [
    stateRead(base, gprChannel("eax")),
    memoryRead(loaded, address, 32)
  ]);

  strictEqual(analysis.useCount(loaded), 0);
  strictEqual(analysis.useCount(address), 0);
  strictEqual(analysis.useCount(base), 0);
  strictEqual(analysis.useCount(offset), 0);
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
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(five), 1);
});

test("repeated child edges within one compound count separately", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const doubled = values.binary("add", read, read);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), doubled)
  ]);

  strictEqual(analysis.useCount(doubled), 1);
  strictEqual(analysis.useCount(read), 2);
});

test("a compound shared by selected bodies charges its children once", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const sum = values.binary("add", read, one);
  const analysis = analyze(values, [
    stateRead(read, gprChannel("eax")),
    {
      kind: "if",
      condition,
      thenBody: { actions: [stateWrite(gprChannel("ebx"), sum)] },
      elseBody: { actions: [stateWrite(gprChannel("ecx"), sum)] }
    }
  ]);

  strictEqual(analysis.useCount(sum), 2);
  strictEqual(analysis.useCount(read), 1);
  strictEqual(analysis.useCount(one), 1);
});

test("an output used by sibling bodies counts both emitted references", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const firstCondition = values.external(0);
  const secondCondition = values.external(1);
  const analysis = analyze(values, [
    stateRead(output, gprChannel("eax")),
    {
      kind: "if",
      condition: firstCondition,
      thenBody: { actions: [stateWrite(gprChannel("ebx"), output)] }
    },
    {
      kind: "if",
      condition: secondCondition,
      thenBody: { actions: [stateWrite(gprChannel("ecx"), output)] }
    }
  ]);

  strictEqual(analysis.useCount(output), 2);
  strictEqual(analysis.useCount(firstCondition), 1);
  strictEqual(analysis.useCount(secondCondition), 1);
});

test("an output in a loop body counts one emitted reference, not iterations", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const analysis = analyze(values, [
    stateRead(output, gprChannel("eax")),
    {
      kind: "loop",
      carried: [],
      body: {
        actions: [
          stateWrite(gprChannel("ebx"), output),
          { kind: "loopContinue", updates: [] }
        ]
      }
    }
  ]);

  strictEqual(analysis.useCount(output), 1);
});

test("a live switch output charges each arm result", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const first = values.const(11);
  const fallback = values.const(22);
  const output = values.addActionOutput();
  const analysis = analyze(values, [
    {
      kind: "switch",
      selector,
      output,
      cases: [{ match: 0, body: { actions: [], result: first } }],
      defaultBody: { actions: [], result: fallback }
    },
    stateWrite(gprChannel("eax"), output)
  ]);

  strictEqual(analysis.useCount(selector), 1);
  strictEqual(analysis.useCount(output), 1);
  strictEqual(analysis.useCount(first), 1);
  strictEqual(analysis.useCount(fallback), 1);
});

test("a dead switch output does not charge arm results", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const first = values.const(11);
  const fallback = values.const(22);
  const output = values.addActionOutput();
  const analysis = analyze(values, [{
    kind: "switch",
    selector,
    output,
    cases: [{ match: 0, body: { actions: [], result: first } }],
    defaultBody: { actions: [], result: fallback }
  }]);

  strictEqual(analysis.useCount(selector), 1);
  strictEqual(analysis.useCount(output), 0);
  strictEqual(analysis.useCount(first), 0);
  strictEqual(analysis.useCount(fallback), 0);
});

test("an exported output is an ordinary demand root", () => {
  const values = new ValueTable();
  const read = values.addActionOutput();
  const analysis = analyze(values, [stateRead(read, gprChannel("eax"))], [read]);

  strictEqual(analysis.useCount(read), 1);
});

test("value uses reject unknown value ids", () => {
  const values = new ValueTable();
  const analysis = analyze(values, []);

  throws(() => analysis.useCount(valueId(99)), /unknown value id 99/);
});
