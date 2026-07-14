import { strictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import {
  memoryRead,
  memoryWrite,
  stateRead,
  stateWrite
} from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#compiler/ir/values/table.js";
import { analyzeLiveness } from "#wasm/emit/liveness.js";
import { planProducerSchedule } from "#wasm/emit/schedule/build.js";
import { analyzeDemands } from "#wasm/emit/schedule/demands.js";
import { indexProducerEvents } from "#wasm/emit/schedule/model.js";
import { verifyProducerEvents } from "#wasm/emit/schedule/verify.js";
import { analyzeValueUses } from "#wasm/emit/value-uses.js";

function analyze(block: IrBlock) {
  const liveness = analyzeLiveness(block);
  const uses = analyzeValueUses(block, liveness);
  const schedule = planProducerSchedule(block, liveness, uses, []);

  return { liveness, uses, schedule };
}

function analyzeForVerifier(block: IrBlock) {
  return { ...analyze(block), demands: analyzeDemands(block) };
}

test("a sole selected-body demand receives a use event inside that body", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const thenBody = { actions: [stateWrite(gprChannel("ebx"), output)] };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        { kind: "if", condition, thenBody }
      ]
    }
  };
  const event = analyze(block).schedule.event(output);

  strictEqual(event?.site.body, thenBody);
  strictEqual(event?.site.actionIndex, 0);
  strictEqual(event?.delivery, "use");
});

test("sibling demands share one common parent capture", () => {
  const values = new ValueTable();
  const firstCondition = values.external(0);
  const secondCondition = values.external(1);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
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
      ]
    }
  };
  const schedule = analyze(block).schedule;
  const event = schedule.event(output);

  strictEqual(schedule.events().length, 1);
  strictEqual(event?.site.body, block.body);
  strictEqual(event?.site.actionIndex, 1);
  strictEqual(event?.delivery, "capture");
});

test("a projected compound triggers its parent use event", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const compound = values.binary("add", output, values.const(1));
  const thenBody = { actions: [stateWrite(gprChannel("ebx"), compound)] };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        {
          kind: "if",
          condition,
          thenBody
        }
      ]
    }
  };
  const liveness = analyzeLiveness(block);
  const uses = analyzeValueUses(block, liveness);
  const schedule = planProducerSchedule(block, liveness, uses, []);
  const event = schedule.event(output);
  const inputs = schedule.inputsForBody(thenBody);

  strictEqual(event?.site.body, block.body);
  strictEqual(event?.site.actionIndex, 1);
  strictEqual(event?.delivery, "use");
  strictEqual(inputs.includes(output), false);
  strictEqual(inputs.includes(compound), true);
});

test("a compound producer input scheduled in a body stays in that body", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const base = values.external(1);
  const address = values.binary("add", base, values.const(4));
  const loaded = values.addActionOutput();
  const thenBody = { actions: [stateWrite(gprChannel("eax"), loaded)] };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        memoryRead(loaded, address, 32),
        { kind: "if", condition, thenBody }
      ]
    }
  };
  const liveness = analyzeLiveness(block);
  const uses = analyzeValueUses(block, liveness);
  const schedule = planProducerSchedule(block, liveness, uses, []);
  const event = schedule.event(loaded);

  strictEqual(event?.site.body, thenBody);
  strictEqual(event?.site.actionIndex, 0);
  strictEqual(schedule.inputsForBody(thenBody).includes(address), false);
});

test("a dead nested producer does not capture a value used only later", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const divisor = values.external(1);
  const index = values.binary("div_u", values.const(1), divisor);
  const deadOutput = values.addActionOutput();
  const thenBody = { actions: [
    stateRead(deadOutput, { kind: "gprDynamic", index, byteLength: 4 })
  ] };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        { kind: "if", condition, thenBody },
        stateWrite(gprChannel("eax"), index)
      ]
    }
  };
  const schedule = analyze(block).schedule;

  strictEqual(schedule.event(deadOutput), undefined);
  strictEqual(schedule.inputsForBody(thenBody).includes(index), false);
});

test("an outer producer used by a loop is captured at its preheader", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const loop = {
    kind: "loop" as const,
    carried: [],
    body: { actions: [stateWrite(gprChannel("ebx"), output)] }
  };
  const block: IrBlock = {
    values,
    body: { actions: [stateRead(output, gprChannel("eax")), loop] }
  };
  const event = analyze(block).schedule.event(output);

  strictEqual(event?.site.body, block.body);
  strictEqual(event?.site.actionIndex, 1);
  strictEqual(event?.delivery, "capture");
});

test("an aliasing write on the selected path keeps a snapshot at its producer", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        {
          kind: "if",
          condition,
          thenBody: {
            actions: [
              stateWrite(gprChannel("eax"), values.const(5)),
              stateWrite(gprChannel("ebx"), output)
            ]
          }
        }
      ]
    }
  };
  const event = analyze(block).schedule.event(output);

  strictEqual(event?.site.body, block.body);
  strictEqual(event?.site.actionIndex, 0);
  strictEqual(event?.delivery, "capture");
});

test("a non-aliasing write does not prevent selected-body placement", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const output = values.addActionOutput();
  const thenBody = {
    actions: [
      stateWrite(gprChannel("ebx"), values.const(5)),
      stateWrite(gprChannel("ecx"), output)
    ]
  };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        { kind: "if", condition, thenBody }
      ]
    }
  };
  const event = analyze(block).schedule.event(output);

  strictEqual(event?.site.body, thenBody);
  strictEqual(event?.site.actionIndex, 1);
  strictEqual(event?.delivery, "use");
});

test("guest-memory writes keep an earlier guest-memory read at its producer", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const address = values.const(0x100);
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        memoryRead(output, address, 32),
        {
          kind: "if",
          condition,
          thenBody: {
            actions: [
              memoryWrite(values.const(0x200), values.const(5), 32),
              stateWrite(gprChannel("eax"), output)
            ]
          }
        }
      ]
    }
  };
  const event = analyze(block).schedule.event(output);

  strictEqual(event?.site.body, block.body);
  strictEqual(event?.site.actionIndex, 0);
});

test("a trapping producer input keeps evaluation at the declaration", () => {
  const values = new ValueTable();
  const condition = values.external(0);
  const index = values.binary("div_u", values.const(1), values.external(1));
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, { kind: "gprDynamic", index, byteLength: 4 }),
        {
          kind: "if",
          condition,
          thenBody: {
            actions: [{
              kind: "finish",
              finish: { kind: "exit", exit: { class: "host", reason: "hostTrap" } }
            }]
          }
        },
        stateWrite(gprChannel("eax"), output)
      ]
    }
  };
  const event = analyze(block).schedule.event(output);

  strictEqual(event?.site.body, block.body);
  strictEqual(event?.site.actionIndex, 0);
  strictEqual(event?.delivery, "capture");
});

test("the verifier rejects a producer use-count mismatch", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), output),
        stateWrite(gprChannel("ecx"), output)
      ]
    }
  };
  const { liveness, uses, demands, schedule } = analyzeForVerifier(block);
  const mismatchedUses = {
    useCount: (id: typeof output) =>
      uses.useCount(id) + (id === output ? 1 : 0)
  };

  throws(
    () => verifyProducerEvents(block, liveness, mismatchedUses, demands, schedule),
    /wrong use count/
  );
});

test("the verifier rejects a loop use event ordered after body capture", () => {
  const values = new ValueTable();
  const seed = values.addActionOutput();
  const loopInput = values.addLoopInput();
  const loopBody = { actions: [stateWrite(gprChannel("ebx"), seed)] };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(seed, gprChannel("eax")),
        {
          kind: "loop",
          carried: [{ channel: gprChannel("eax"), seed, loopInput }],
          body: loopBody
        }
      ]
    }
  };
  const { liveness, uses, demands, schedule } = analyzeForVerifier(block);
  const event = schedule.event(seed)!;

  strictEqual(event.delivery, "capture");
  const malformed = indexProducerEvents([{ ...event, delivery: "use" }]);

  throws(
    () => verifyProducerEvents(block, liveness, uses, demands, malformed),
    /occurs after nested-body capture/
  );
});

test("the verifier rejects a switch use event ordered after arm capture", () => {
  const values = new ValueTable();
  const selector = values.addActionOutput();
  const result = values.const(0);
  const switchOutput = values.addActionOutput();
  const caseBody = {
    actions: [stateWrite(gprChannel("ebx"), selector)],
    result
  };
  const defaultBody = { actions: [], result };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(selector, gprChannel("eax")),
        {
          kind: "switch",
          selector,
          output: switchOutput,
          cases: [{ match: 0, body: caseBody }],
          defaultBody
        }
      ]
    }
  };
  const { liveness, uses, demands, schedule } = analyzeForVerifier(block);
  const event = schedule.event(selector)!;

  strictEqual(event.delivery, "capture");
  const malformed = indexProducerEvents([{ ...event, delivery: "use" }]);

  throws(
    () => verifyProducerEvents(block, liveness, uses, demands, malformed),
    /occurs after nested-body capture/
  );
});

test("the verifier rejects an event sunk from outside into a loop", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const loopBody = { actions: [stateWrite(gprChannel("ebx"), output)] };
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        { kind: "loop", carried: [], body: loopBody }
      ]
    }
  };
  const { liveness, uses, demands, schedule } = analyzeForVerifier(block);
  const event = schedule.event(output)!;
  const malformed = indexProducerEvents([{
    ...event,
    site: { body: loopBody, actionIndex: 0 },
    delivery: "use"
  }]);

  throws(
    () => verifyProducerEvents(block, liveness, uses, demands, malformed),
    /moves from outside into a loop body/
  );
});
