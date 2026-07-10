import { deepStrictEqual, throws } from "node:assert";
import { test } from "node:test";

import type { IrBlock } from "#ir/block.js";
import { gprChannel } from "#ir/slots.js";
import { stateRead, stateWrite } from "#ir/tests/storage-op-helpers.js";
import { ValueTable } from "#ir/value-table.js";
import { analyzeLiveness } from "#wasm/emit/liveness.js";
import { planProducerSchedule } from "#wasm/emit/schedule/build.js";
import { ProducerScheduleExecutor } from "#wasm/emit/schedule/executor.js";
import { analyzeValueUses } from "#wasm/emit/value-uses.js";

function plan(block: IrBlock) {
  const liveness = analyzeLiveness(block);
  const uses = analyzeValueUses(block, liveness);

  return planProducerSchedule(block, liveness, uses, []);
}

test("a use event executes only at its planned site", () => {
  const values = new ValueTable();
  const output = values.addActionOutput();
  const block: IrBlock = {
    values,
    body: {
      actions: [
        stateRead(output, gprChannel("eax")),
        stateWrite(gprChannel("ebx"), output)
      ]
    }
  };
  const emitted: number[] = [];
  const executor = new ProducerScheduleExecutor(plan(block));
  const unexpectedCapture = (): void => { throw new Error("unexpected capture"); };

  throws(() => executor.assertComplete(), /events never executed/);
  throws(() => executor.executeUse(output), /outside an emission site/);

  executor.withSite(block.body, 1, unexpectedCapture, () => {
    emitted.push(executor.executeUse(output).output);
  });
  executor.assertComplete();
  deepStrictEqual(emitted, [output]);

  throws(
    () => executor.withSite(block.body, 1, unexpectedCapture, () => {
      executor.executeUse(output);
    }),
    /event executed twice/
  );
});

test("a capture event is dispatched by its site index", () => {
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
  const captured: number[] = [];
  const executor = new ProducerScheduleExecutor(plan(block));

  executor.withSite(
    block.body,
    1,
    (event) => { captured.push(event.output); },
    () => {}
  );
  executor.assertComplete();
  deepStrictEqual(captured, [output]);
});
