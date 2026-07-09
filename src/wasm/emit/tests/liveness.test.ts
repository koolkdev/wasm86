import { strictEqual } from "node:assert";
import { test } from "node:test";

import type { Action } from "#ir/actions.js";
import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { memoryCheck, memoryRead, stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import { validateIrBlock } from "#ir/validate.js";
import { ValueTable } from "#ir/value-table.js";
import { fitsUnsigned, type ValueId } from "#ir/values.js";
import { analyzeLiveness } from "#wasm/emit/liveness.js";

function analyze(block: IrBlock, exportedOutputs: readonly ValueId[] = []) {
  validateIrBlock(block, {
    allowImplicitEntryFallthrough: true,
    exportedOutputs
  });
  return analyzeLiveness(block, exportedOutputs);
}

test("dead producer chains remain non-live", () => {
  const values = new ValueTable();
  const base = values.addActionOutput();
  const address = values.binary("add", base, values.const(4));
  const byteLength = values.const(4);
  const checked = values.addActionOutput(fitsUnsigned(1));
  const block = {
    values,
    body: {
      actions: [
        stateRead(base, gprChannel("eax")),
        memoryCheck(checked, address, byteLength, "read")
      ]
    }
  } as const;
  const liveness = analyze(block);

  strictEqual(liveness.isLive(base), false);
  strictEqual(liveness.isLive(address), false);
  strictEqual(liveness.isLive(byteLength), false);
  strictEqual(liveness.isLive(checked), false);
});

test("an unused memory read leaves its address chain non-live", () => {
  const values = new ValueTable();
  const base = values.addActionOutput();
  const offset = values.const(8);
  const address = values.binary("add", base, offset);
  const loaded = values.addActionOutput();
  const read = memoryRead(loaded, address, 32);
  const block = {
    values,
    body: { actions: [stateRead(base, gprChannel("eax")), read] }
  } as const;
  const liveness = analyze(block);

  strictEqual(liveness.isLive(loaded), false);
  strictEqual(liveness.isLive(address), false);
  strictEqual(liveness.isLive(base), false);
  strictEqual(liveness.isLive(offset), false);
});

test("action, control, loop, finish, and boundary roots seed liveness", () => {
  const values = new ValueTable();
  const exported = values.addActionOutput();
  const mutated = values.const(11);
  const condition = values.external(0);
  const nestedMutation = values.const(12);
  const selector = values.external(1);
  const firstResult = values.const(13);
  const defaultResult = values.const(14);
  const switchOutput = values.addActionOutput();
  const loopSeed = values.const(15);
  const loopInput = values.addLoopInput();
  const increment = values.const(1);
  const loopUpdate = values.binary("add", loopInput, increment);
  const finishPayload = values.const(16);
  const actions: readonly Action[] = [
    stateRead(exported, gprChannel("eax")),
    stateWrite(gprChannel("ebx"), mutated),
    {
      kind: "if",
      condition,
      thenBody: { actions: [stateWrite(gprChannel("ecx"), nestedMutation)] }
    },
    {
      kind: "switch",
      selector,
      output: switchOutput,
      cases: [{ match: 0, body: { actions: [], result: firstResult } }],
      defaultBody: { actions: [], result: defaultResult }
    },
    {
      kind: "loop",
      carried: [{ channel: gprChannel("edx"), seed: loopSeed, loopInput }],
      body: { actions: [{ kind: "loopContinue", updates: [loopUpdate] }] }
    },
    {
      kind: "finish",
      finish: {
        kind: "exit",
        exit: { class: "host", reason: "hostTrap", payload: finishPayload }
      }
    }
  ];
  const block = { values, body: { actions } };
  const liveness = analyze(block, [exported, switchOutput]);

  for (const live of [
    exported,
    mutated,
    condition,
    nestedMutation,
    selector,
    switchOutput,
    firstResult,
    defaultResult,
    loopSeed,
    loopInput,
    increment,
    loopUpdate,
    finishPayload
  ]) {
    strictEqual(liveness.isLive(live), true, `expected value ${live} to be live`);
  }
});

test("a dead switch output does not keep arm results or pure producers live", () => {
  const values = new ValueTable();
  const selector = values.external(0);
  const read = values.addActionOutput();
  const one = values.const(1);
  const result = values.binary("add", read, one);
  const fallback = values.const(0);
  const output = values.addActionOutput();
  const block = {
    values,
    body: {
      actions: [
        {
          kind: "switch",
          selector,
          output,
          cases: [
            {
              match: 0,
              body: {
                actions: [stateRead(read, gprChannel("eax"))],
                result
              }
            }
          ],
          defaultBody: { actions: [], result: fallback }
        }
      ]
    }
  } as const;
  const liveness = analyze(block);

  strictEqual(liveness.isLive(selector), true);
  strictEqual(liveness.isLive(output), false);
  strictEqual(liveness.isLive(result), false);
  strictEqual(liveness.isLive(read), false);
  strictEqual(liveness.isLive(one), false);
  strictEqual(liveness.isLive(fallback), false);
});
